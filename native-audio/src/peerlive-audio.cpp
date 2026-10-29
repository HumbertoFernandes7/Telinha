/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// peerlive-audio.exe: helper do PeerLive para o audio da TELA INTEIRA.
//
// Captura tudo o que o Windows esta tocando EXCETO o audio de uma arvore de processos (o Discord),
// via WASAPI process loopback (ActivateAudioInterfaceAsync + AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
// Windows 10 2004 / build 19041+), e escreve PCM cru no stdout:
//
//     48000 Hz, 2 canais, float32 little-endian, intercalado (8 bytes por frame)
//
// Quando ninguem toca nada o Windows nao entrega pacotes; o helper completa com silencio no ritmo do
// relogio para o stream de saida ser continuo.
//
// Uso:
//     peerlive-audio.exe --exclude <pid> [--parent <pid>] [--seconds <n>]   captura tudo menos a arvore <pid>
//     peerlive-audio.exe --include <pid> [--parent <pid>] [--seconds <n>]   so a arvore <pid> (autoteste)
//     peerlive-audio.exe --probe       sai com 0 se o process loopback funciona nesta maquina
//     peerlive-audio.exe --sessions    lista as sessoes de audio de saida (pid, pai, exe) para diagnostico
//     peerlive-audio.exe --version
//
// Para de capturar (saida 0) quando o stdin fecha (EOF ou pipe quebrado), o stdout fecha, o processo
// --parent termina ou --seconds passa. Quem chama DEVE manter o stdin aberto como um pipe.
//
// Status no stderr, uma linha por evento:
//     ready format=f32 rate=48000 channels=2 source=<f32|s16>
//     info <texto>
//     error <etapa> 0x<HRESULT> <mensagem>
//
// Codigos de saida: 0 ok, 1 erro durante a captura, 2 argumentos, 3 Windows antigo, 4 ativacao, 5 inicializacao.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmreg.h>
#include <tlhelp32.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <avrt.h>

#include <algorithm>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "avrt.lib")

namespace {

constexpr const char* kVersion = "peerlive-audio 1";
constexpr UINT32 kRate = 48000;
constexpr UINT16 kChannels = 2;
constexpr REFERENCE_TIME kBufferHns = 1000000;   // 100 ms de buffer no WASAPI (a latencia e o periodo, ~10 ms)
constexpr DWORD kWaitMs = 10;
constexpr LONGLONG kGapMs = 40;                    // sem pacotes por mais que isso => completar com silencio
constexpr DWORD kMinBuild = 19041;                 // Windows 10 2004

HANDLE g_stop = nullptr;

void Line(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);
    fputc('\n', stderr);
    fflush(stderr);
}

std::string Utf8(const wchar_t* text) {
    if (!text || !*text) return std::string();
    const int n = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return std::string();
    std::string out(static_cast<size_t>(n - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), n, nullptr, nullptr);
    return out;
}

std::string HrText(HRESULT hr) {
    wchar_t* buf = nullptr;
    const DWORD n = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, static_cast<DWORD>(hr), 0, reinterpret_cast<wchar_t*>(&buf), 0, nullptr);
    std::string text = n ? Utf8(buf) : std::string();
    if (buf) LocalFree(buf);
    // uma linha so
    for (char& c : text) if (c == '\r' || c == '\n') c = ' ';
    while (!text.empty() && text.back() == ' ') text.pop_back();
    return text.empty() ? std::string("(sem descricao)") : text;
}

void Fail(const char* stage, HRESULT hr) {
    Line("error %s 0x%08lX %s", stage, static_cast<unsigned long>(hr), HrText(hr).c_str());
}

DWORD OsBuild() {
    using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) return 0;
    const auto fn = reinterpret_cast<RtlGetVersionFn>(reinterpret_cast<void*>(GetProcAddress(ntdll, "RtlGetVersion")));
    RTL_OSVERSIONINFOW v = {};
    v.dwOSVersionInfoSize = sizeof(v);
    return fn && fn(&v) == 0 ? v.dwBuildNumber : 0;
}

bool ParseUInt(const wchar_t* text, unsigned long long max, unsigned long long& out) {
    if (!text || !*text) return false;
    for (const wchar_t* p = text; *p; ++p)
        if (*p < L'0' || *p > L'9') return false;
    if (wcslen(text) > 10) return false;
    out = wcstoull(text, nullptr, 10);
    return out >= 1 && out <= max;
}

// #region ativacao (o handler precisa ser agile: IAgileObject)

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
public:
    ActivationHandler() : done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) { }
    ActivationHandler(const ActivationHandler&) = delete;
    ActivationHandler& operator=(const ActivationHandler&) = delete;

    HANDLE Done() const { return done_; }

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        } else if (riid == __uuidof(IAgileObject)) {
            *ppv = static_cast<IAgileObject*>(this);
        } else {
            *ppv = nullptr;
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }

    STDMETHODIMP_(ULONG) AddRef() override { return static_cast<ULONG>(InterlockedIncrement(&ref_)); }

    STDMETHODIMP_(ULONG) Release() override {
        const LONG r = InterlockedDecrement(&ref_);
        if (r == 0) delete this;
        return static_cast<ULONG>(r);
    }

    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation*) override {
        SetEvent(done_);
        return S_OK;
    }

private:
    ~ActivationHandler() {
        if (done_) CloseHandle(done_);
    }

    volatile LONG ref_ = 1;
    HANDLE done_;
};

HRESULT ActivateLoopback(DWORD pid, bool include, IAudioClient** out) {
    *out = nullptr;

    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = include
        ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
        : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT pv = {};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(params);
    pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    auto* handler = new ActivationHandler();
    if (!handler->Done()) {
        handler->Release();
        return HRESULT_FROM_WIN32(GetLastError());
    }

    IActivateAudioInterfaceAsyncOperation* op = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler, &op);
    if (SUCCEEDED(hr)) {
        if (WaitForSingleObject(handler->Done(), 5000) != WAIT_OBJECT_0) {
            hr = HRESULT_FROM_WIN32(ERROR_TIMEOUT);
        } else {
            HRESULT activateHr = E_FAIL;
            IUnknown* unk = nullptr;
            hr = op->GetActivateResult(&activateHr, &unk);
            if (SUCCEEDED(hr)) hr = activateHr;
            if (SUCCEEDED(hr)) hr = unk ? unk->QueryInterface(IID_PPV_ARGS(out)) : E_NOINTERFACE;
            if (unk) unk->Release();
        }
    }
    if (op) op->Release();
    handler->Release();
    return hr;
}

HRESULT InitClient(IAudioClient* client, bool asFloat) {
    WAVEFORMATEX f = {};
    f.wFormatTag = asFloat ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM;
    f.nChannels = kChannels;
    f.nSamplesPerSec = kRate;
    f.wBitsPerSample = asFloat ? 32 : 16;
    f.nBlockAlign = static_cast<WORD>(f.nChannels * f.wBitsPerSample / 8);
    f.nAvgBytesPerSec = f.nSamplesPerSec * f.nBlockAlign;
    f.cbSize = 0;
    return client->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        kBufferHns, 0, &f, nullptr);
}

/** Ativa e inicializa: float32 primeiro, PCM 16 bits se o Windows recusar float. */
HRESULT OpenClient(DWORD pid, bool include, IAudioClient** out, bool& asFloat, const char*& stage) {
    stage = "activate";
    HRESULT hr = ActivateLoopback(pid, include, out);
    if (FAILED(hr)) return hr;

    stage = "initialize";
    asFloat = true;
    hr = InitClient(*out, true);
    if (SUCCEEDED(hr)) return hr;

    (*out)->Release();
    *out = nullptr;
    asFloat = false;
    stage = "activate";
    hr = ActivateLoopback(pid, include, out);
    if (FAILED(hr)) return hr;
    stage = "initialize";
    hr = InitClient(*out, false);
    if (FAILED(hr)) {
        (*out)->Release();
        *out = nullptr;
    }
    return hr;
}

// #endregion

// #region captura

bool WriteAll(HANDLE out, const void* data, size_t bytes) {
    const auto* p = static_cast<const BYTE*>(data);
    while (bytes) {
        DWORD written = 0;
        const DWORD chunk = static_cast<DWORD>(std::min<size_t>(bytes, 1 << 20));
        if (!WriteFile(out, p, chunk, &written, nullptr) || written == 0) return false;
        p += written;
        bytes -= written;
    }
    return true;
}

DWORD WINAPI StdinWatcher(LPVOID) {
    const HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    if (in && in != INVALID_HANDLE_VALUE) {
        char buf[256];
        DWORD n = 0;
        while (ReadFile(in, buf, sizeof(buf), &n, nullptr) && n > 0) { }
    }
    SetEvent(g_stop);
    return 0;
}

BOOL WINAPI CtrlHandler(DWORD) {
    if (g_stop) SetEvent(g_stop);
    return TRUE;
}

LONGLONG Qpc() {
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);
    return t.QuadPart;
}

struct CaptureOptions {
    DWORD pid = 0;
    bool include = false;
    DWORD parent = 0;
    double seconds = 0;
};

void AppendFrames(std::vector<float>& dst, const BYTE* data, UINT32 frames, DWORD flags, bool asFloat) {
    const size_t n = static_cast<size_t>(frames) * kChannels;
    const size_t base = dst.size();
    dst.resize(base + n);
    float* p = dst.data() + base;
    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !data) {
        std::fill(p, p + n, 0.0f);
    } else if (asFloat) {
        memcpy(p, data, n * sizeof(float));
    } else {
        const auto* s = reinterpret_cast<const int16_t*>(data);
        for (size_t i = 0; i < n; i++) p[i] = static_cast<float>(s[i]) / 32768.0f;
    }
}

int RunCapture(const CaptureOptions& o) {
    const HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!out || out == INVALID_HANDLE_VALUE) {
        Fail("stdout", HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE));
        return 2;
    }

    HANDLE parent = nullptr;
    if (o.parent) {
        parent = OpenProcess(SYNCHRONIZE, FALSE, o.parent);
        if (!parent) {
            Fail("parent", HRESULT_FROM_WIN32(GetLastError()));
            return 2;
        }
    }

    IAudioClient* client = nullptr;
    IAudioCaptureClient* capture = nullptr;
    HANDLE audioEvent = nullptr;
    HANDLE mmTask = nullptr;
    bool asFloat = true;
    bool started = false;
    int exitCode = 0;
    const char* stage = "activate";

    HRESULT hr = OpenClient(o.pid, o.include, &client, asFloat, stage);
    if (FAILED(hr)) {
        Fail(stage, hr);
        exitCode = strcmp(stage, "activate") == 0 ? 4 : 5;
        goto done;
    }

    audioEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    hr = audioEvent ? client->SetEventHandle(audioEvent) : HRESULT_FROM_WIN32(GetLastError());
    if (SUCCEEDED(hr)) hr = client->GetService(IID_PPV_ARGS(&capture));
    if (FAILED(hr)) {
        Fail("initialize", hr);
        exitCode = 5;
        goto done;
    }

    if (!CreateThread(nullptr, 0, StdinWatcher, nullptr, 0, nullptr)) {
        Fail("stdin", HRESULT_FROM_WIN32(GetLastError()));
        exitCode = 1;
        goto done;
    }

    {
        DWORD taskIndex = 0;
        mmTask = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
    }

    hr = client->Start();
    if (FAILED(hr)) {
        Fail("start", hr);
        exitCode = 5;
        goto done;
    }
    started = true;
    Line("ready format=f32 rate=%u channels=%u source=%s", kRate, kChannels, asFloat ? "f32" : "s16");

    {
        LARGE_INTEGER freqLi;
        QueryPerformanceFrequency(&freqLi);
        const LONGLONG freq = freqLi.QuadPart;
        const ULONGLONG deadline = o.seconds > 0 ? GetTickCount64() + static_cast<ULONGLONG>(o.seconds * 1000.0) : 0;

        std::vector<float> buf;
        buf.reserve(kRate / 10 * kChannels);
        static const float kZeros[kRate / 100 * kChannels] = {};   // 10 ms de silencio

        LONGLONG lastPacket = Qpc();
        LONGLONG gapStart = 0;
        unsigned long long gapFrames = 0;
        bool inGap = false;
        unsigned long long discontinuities = 0;

        HANDLE waits[3] = { g_stop, audioEvent, parent };
        const DWORD nWaits = parent ? 3 : 2;

        for (;;) {
            const DWORD w = WaitForMultipleObjects(nWaits, waits, FALSE, kWaitMs);
            if (w == WAIT_OBJECT_0) break;
            if (parent && w == WAIT_OBJECT_0 + 2) {
                Line("info parent exited");
                break;
            }
            if (w == WAIT_FAILED) {
                Fail("wait", HRESULT_FROM_WIN32(GetLastError()));
                exitCode = 1;
                break;
            }
            if (deadline && GetTickCount64() >= deadline) break;

            buf.clear();
            for (;;) {
                UINT32 next = 0;
                hr = capture->GetNextPacketSize(&next);
                if (FAILED(hr) || next == 0) break;
                BYTE* data = nullptr;
                UINT32 frames = 0;
                DWORD flags = 0;
                hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
                if (FAILED(hr)) break;
                if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) discontinuities++;
                if (frames) AppendFrames(buf, data, frames, flags, asFloat);
                hr = capture->ReleaseBuffer(frames);
                if (FAILED(hr)) break;
            }
            if (FAILED(hr)) {
                Fail("capture", hr);
                exitCode = 1;
                break;
            }

            const LONGLONG now = Qpc();
            if (!buf.empty()) {
                lastPacket = now;
                inGap = false;
                if (!WriteAll(out, buf.data(), buf.size() * sizeof(float))) break;   // stdout fechado: fim normal
                continue;
            }

            if (!inGap && now - lastPacket > freq * kGapMs / 1000) {
                inGap = true;
                gapStart = lastPacket;
                gapFrames = 0;
            }
            if (inGap) {
                const unsigned long long due = static_cast<unsigned long long>((now - gapStart) * static_cast<LONGLONG>(kRate) / freq);
                bool ok = true;
                while (ok && gapFrames < due) {
                    const unsigned long long n = std::min<unsigned long long>(due - gapFrames, kRate / 100);
                    ok = WriteAll(out, kZeros, static_cast<size_t>(n) * kChannels * sizeof(float));
                    gapFrames += n;
                }
                if (!ok) break;
            }
        }
        if (discontinuities) Line("info discontinuities=%llu", discontinuities);
    }

done:
    if (started) client->Stop();
    if (mmTask) AvRevertMmThreadCharacteristics(mmTask);
    if (capture) capture->Release();
    if (client) client->Release();
    if (audioEvent) CloseHandle(audioEvent);
    if (parent) CloseHandle(parent);
    return exitCode;
}

// #endregion

int Probe() {
    IAudioClient* client = nullptr;
    bool asFloat = true;
    const char* stage = "activate";
    const HRESULT hr = OpenClient(GetCurrentProcessId(), false, &client, asFloat, stage);
    if (FAILED(hr)) {
        Fail(stage, hr);
        return strcmp(stage, "activate") == 0 ? 4 : 5;
    }
    client->Release();
    Line("ready probe source=%s", asFloat ? "f32" : "s16");
    return 0;
}

// #region diagnostico: sessoes de audio de saida

struct ProcInfo {
    DWORD ppid;
    std::string exe;
};

std::vector<std::pair<DWORD, ProcInfo>> SnapshotProcesses() {
    std::vector<std::pair<DWORD, ProcInfo>> list;
    const HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return list;
    PROCESSENTRY32W e = {};
    e.dwSize = sizeof(e);
    for (BOOL ok = Process32FirstW(snap, &e); ok; ok = Process32NextW(snap, &e))
        list.push_back({ e.th32ProcessID, { e.th32ParentProcessID, Utf8(e.szExeFile) } });
    CloseHandle(snap);
    return list;
}

int ListSessions() {
    const auto procs = SnapshotProcesses();
    const auto find = [&](DWORD pid) -> const ProcInfo* {
        for (const auto& p : procs)
            if (p.first == pid) return &p.second;
        return nullptr;
    };

    IMMDeviceEnumerator* en = nullptr;
    IMMDeviceCollection* col = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
    if (SUCCEEDED(hr)) hr = en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col);
    UINT count = 0;
    if (SUCCEEDED(hr)) hr = col->GetCount(&count);
    if (FAILED(hr)) {
        Fail("sessions", hr);
        if (col) col->Release();
        if (en) en->Release();
        return 1;
    }

    for (UINT i = 0; i < count; i++) {
        IMMDevice* dev = nullptr;
        IAudioSessionManager2* mgr = nullptr;
        IAudioSessionEnumerator* sessions = nullptr;
        int n = 0;
        if (FAILED(col->Item(i, &dev))) continue;
        if (SUCCEEDED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&mgr))) &&
            SUCCEEDED(mgr->GetSessionEnumerator(&sessions)) && SUCCEEDED(sessions->GetCount(&n))) {
            for (int j = 0; j < n; j++) {
                IAudioSessionControl* ctl = nullptr;
                IAudioSessionControl2* ctl2 = nullptr;
                if (FAILED(sessions->GetSession(j, &ctl))) continue;
                DWORD pid = 0;
                AudioSessionState state = AudioSessionStateInactive;
                ctl->GetState(&state);
                if (SUCCEEDED(ctl->QueryInterface(IID_PPV_ARGS(&ctl2)))) {
                    ctl2->GetProcessId(&pid);
                    ctl2->Release();
                }
                ctl->Release();
                const ProcInfo* info = find(pid);
                printf("session device=%u pid=%lu ppid=%lu state=%s exe=%s\n", i, static_cast<unsigned long>(pid),
                    static_cast<unsigned long>(info ? info->ppid : 0),
                    state == AudioSessionStateActive ? "active" : state == AudioSessionStateExpired ? "expired" : "inactive",
                    info ? info->exe.c_str() : "?");
            }
        }
        if (sessions) sessions->Release();
        if (mgr) mgr->Release();
        dev->Release();
    }
    col->Release();
    en->Release();
    fflush(stdout);
    return 0;
}

// #endregion

int Usage() {
    Line("error usage 0x80070057 uso: peerlive-audio.exe (--exclude <pid> | --include <pid>) [--parent <pid>] [--seconds <n>] | --probe | --sessions | --version");
    return 2;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    CaptureOptions o;
    bool probe = false, sessions = false, haveTarget = false;

    for (int i = 1; i < argc; i++) {
        const wchar_t* a = argv[i];
        const wchar_t* v = i + 1 < argc ? argv[i + 1] : nullptr;
        unsigned long long n = 0;
        if (!wcscmp(a, L"--version")) {
            printf("%s\n", kVersion);
            return 0;
        } else if (!wcscmp(a, L"--probe")) {
            probe = true;
        } else if (!wcscmp(a, L"--sessions")) {
            sessions = true;
        } else if ((!wcscmp(a, L"--exclude") || !wcscmp(a, L"--include")) && !haveTarget && ParseUInt(v, 0xFFFFFFFFull, n)) {
            o.pid = static_cast<DWORD>(n);
            o.include = !wcscmp(a, L"--include");
            haveTarget = true;
            i++;
        } else if (!wcscmp(a, L"--parent") && ParseUInt(v, 0xFFFFFFFFull, n)) {
            o.parent = static_cast<DWORD>(n);
            i++;
        } else if (!wcscmp(a, L"--seconds") && ParseUInt(v, 86400, n)) {
            o.seconds = static_cast<double>(n);
            i++;
        } else {
            return Usage();
        }
    }
    if (static_cast<int>(probe) + static_cast<int>(sessions) + static_cast<int>(haveTarget) != 1) return Usage();

    const DWORD build = OsBuild();
    if (!sessions && build < kMinBuild) {
        Line("error os 0x80070032 Windows build %lu: o audio da tela exige Windows 10 2004 (build 19041) ou mais novo", static_cast<unsigned long>(build));
        return 3;
    }

    g_stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!g_stop) return 1;
    SetConsoleCtrlHandler(CtrlHandler, TRUE);

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        Fail("com", hr);
        return 1;
    }

    int code;
    if (sessions) code = ListSessions();
    else if (probe) code = Probe();
    else code = RunCapture(o);

    CoUninitialize();
    return code;
}
