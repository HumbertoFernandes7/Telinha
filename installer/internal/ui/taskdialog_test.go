// SPDX-License-Identifier: GPL-3.0-or-later

package ui

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// These tests never open a window: the five calls that need a desktop (TaskDialogIndirect, MessageBoxW,
// SendMessageW, ShellExecute and the availability probe) are replaced by fakes that record what the package
// asks of them, and a fake dialog drives the callback the way Windows' message loop would. What stays
// untested is Windows' own window code.

// fakeOS replaces the OS calls for one test and restores them afterwards.
type fakeOS struct {
	t *testing.T

	mu         sync.Mutex
	sent       []sentMessage
	boxes      []box
	opened     []string
	logs       []string
	dialogs    int
	boxAnswer  int
	dialogHook func(cfg []byte, button, radio *int32) uintptr
}

type sentMessage struct {
	hwnd, msg, wparam, lparam uintptr
	text                      string // for tdmSetElementText
}

type box struct {
	text, caption string
	style         uint32
}

func install(t *testing.T, availableNow bool) *fakeOS {
	t.Helper()
	f := &fakeOS{t: t}
	oldAvail, oldTD, oldSend, oldBox, oldOpen, oldLogf, oldAuto := available, taskDialogIndirect, sendMessage, messageBox, shellOpen, Logf, AutoClick
	available = func() bool { return availableNow }
	taskDialogIndirect = func(cfg []byte, button, radio *int32) uintptr {
		f.mu.Lock()
		f.dialogs++
		hook := f.dialogHook
		f.mu.Unlock()
		if hook == nil {
			t.Error("a dialog was shown but the test did not expect one")
			return 0
		}
		return hook(cfg, button, radio)
	}
	sendMessage = func(hwnd, msg, wparam, lparam uintptr) uintptr {
		m := sentMessage{hwnd: hwnd, msg: msg, wparam: wparam, lparam: lparam}
		if msg == tdmSetElementText && lparam != 0 {
			m.text = windows.UTF16PtrToString(osString(lparam))
		}
		f.mu.Lock()
		f.sent = append(f.sent, m)
		f.mu.Unlock()
		return 0
	}
	messageBox = func(text, caption string, style uint32) int {
		f.mu.Lock()
		f.boxes = append(f.boxes, box{text, caption, style})
		answer := f.boxAnswer
		f.mu.Unlock()
		return answer
	}
	shellOpen = func(url string) {
		f.mu.Lock()
		f.opened = append(f.opened, url)
		f.mu.Unlock()
	}
	Logf = func(format string, args ...any) {
		f.mu.Lock()
		f.logs = append(f.logs, fmt.Sprintf(format, args...))
		f.mu.Unlock()
	}
	AutoClick = 0
	t.Cleanup(func() {
		available, taskDialogIndirect, sendMessage, messageBox, shellOpen, Logf, AutoClick = oldAvail, oldTD, oldSend, oldBox, oldOpen, oldLogf, oldAuto
	})
	return f
}

func (f *fakeOS) sentMsgs() []sentMessage {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sentMessage(nil), f.sent...)
}

func (f *fakeOS) clicks() (ids []uintptr) {
	for _, m := range f.sentMsgs() {
		if m.msg == tdmClickButton {
			ids = append(ids, m.wparam)
		}
	}
	return ids
}

func (f *fakeOS) logged(sub string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, l := range f.logs {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}

func handlerNow() func(hwnd, msg, wparam, lparam uintptr) uintptr {
	activeMu.Lock()
	defer activeMu.Unlock()
	return activeHandler
}

// ---------------------------------------------------------------------------------------------- pure helpers

func TestIconRes(t *testing.T) {
	for icon, want := range map[Icon]uintptr{IconWarning: 0xFFFF, IconError: 0xFFFE, IconInfo: 0xFFFD, IconShield: 0xFFFC, IconApp: 0, Icon(99): 0} {
		if got := iconRes(icon); got != want {
			t.Errorf("iconRes(%d) = %#x, want %#x", icon, got, want)
		}
	}
}

func TestFirstLine(t *testing.T) {
	for in, want := range map[string]string{"": "", "one": "one", "Title\nexplanation": "Title", "\nx": "", "a\nb\nc": "a", "Não\nsim": "Não"} {
		if got := firstLine(in); got != want {
			t.Errorf("firstLine(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFirstCommon(t *testing.T) {
	for c, want := range map[int]int{0: IDOK, BtnOK: IDOK, BtnYes | BtnNo: IDOK, BtnCancel: IDCANCEL, BtnClose: IDCLOSE, BtnOK | BtnCancel: IDCANCEL, BtnClose | BtnCancel: IDCANCEL, BtnOK | BtnClose: IDCLOSE} {
		if got := firstCommon(c); got != want {
			t.Errorf("firstCommon(%#x) = %d, want %d", c, got, want)
		}
	}
}

func TestDefaultButton(t *testing.T) {
	for name, tc := range map[string]struct {
		d    Dialog
		want int
	}{
		"explicit default":   {Dialog{Default: 103, Buttons: []Button{{ID: 101}}, Common: BtnCancel}, 103},
		"first custom":       {Dialog{Buttons: []Button{{ID: 101}, {ID: 102}}, Common: BtnCancel}, 101},
		"ok":                 {Dialog{Common: BtnOK | BtnCancel}, IDOK},
		"cancel only":        {Dialog{Common: BtnCancel}, IDCANCEL},
		"close only":         {Dialog{Common: BtnClose}, IDCLOSE},
		"nothing at all":     {Dialog{}, IDOK},
		"yes/no has no pick": {Dialog{Common: BtnYes | BtnNo}, IDOK},
	} {
		if got := tc.d.defaultButton(); got != tc.want {
			t.Errorf("%s: %d, want %d", name, got, tc.want)
		}
	}
}

func TestPackerStrings(t *testing.T) {
	p := &packer{}
	if p.str("") != 0 {
		t.Fatal("empty string must be a NULL pointer")
	}
	if got := windows.UTF16PtrToString(osString(p.str("Instalação ✓"))); got != "Instalação ✓" {
		t.Fatalf("round trip: %q", got)
	}
	// a NUL cannot go into a Windows string: the dialog shows "?" instead of failing
	if got := windows.UTF16PtrToString(osString(p.str("bad\x00text"))); got != "?" {
		t.Fatalf("NUL: %q", got)
	}
	if len(p.keep) != 2 {
		t.Fatalf("the packer must keep every string alive until the call returns: %d kept", len(p.keep))
	}
}

func TestPackerNumbers(t *testing.T) {
	p := &packer{}
	p.u32(0x01020304)
	p.ptr(0xAABBCCDD)
	want := []byte{4, 3, 2, 1}
	if unsafe.Sizeof(uintptr(0)) == 8 {
		want = append(want, 0xDD, 0xCC, 0xBB, 0xAA, 0, 0, 0, 0)
	} else {
		want = append(want, 0xDD, 0xCC, 0xBB, 0xAA)
	}
	if string(p.b) != string(want) {
		t.Fatalf("% x, want % x", p.b, want)
	}
}

func TestPackerButtons(t *testing.T) {
	p := &packer{}
	defer runtime.KeepAlive(p) // the array and its strings are read through raw addresses below
	if p.buttons(nil) != 0 || p.buttons([]Button{}) != 0 {
		t.Fatal("no buttons must be a NULL array")
	}
	arr := p.buttons([]Button{{ID: 101, Text: "Instalar\nBaixa e ativa."}, {ID: -5, Text: "Cancelar"}})
	if arr == 0 {
		t.Fatal("NULL array")
	}
	// commctrl.h packs TASKDIALOG_BUTTON (#pragma pack(1)): int ID + pointer, no padding
	ptrSize := int(unsafe.Sizeof(uintptr(0)))
	b := readMemory(arr, 2*(4+ptrSize))
	r := &reader{b: b}
	for i, want := range []struct {
		id   int32
		text string
	}{{101, "Instalar\nBaixa e ativa."}, {-5, "Cancelar"}} {
		if id, text := int32(r.u32()), r.str(); id != want.id || text != want.text {
			t.Errorf("button %d: id %d %q, want %d %q", i, id, text, want.id, want.text)
		}
	}
}

// ------------------------------------------------------------------------------------ TASKDIALOGCONFIG bytes

// readMemory copies n bytes from a raw address that the packer keeps alive (the test holds the packer).
func readMemory(addr uintptr, n int) []byte {
	out := make([]byte, n)
	base := *(**byte)(unsafe.Pointer(&addr))
	for i := range out {
		out[i] = *(*byte)(unsafe.Add(unsafe.Pointer(base), i))
	}
	return out
}

type reader struct {
	b   []byte
	off int
}

func (r *reader) u32() uint32 {
	v := uint32(r.b[r.off]) | uint32(r.b[r.off+1])<<8 | uint32(r.b[r.off+2])<<16 | uint32(r.b[r.off+3])<<24
	r.off += 4
	return v
}

func (r *reader) ptr() uintptr {
	n := int(unsafe.Sizeof(uintptr(0)))
	var v uintptr
	for i := n - 1; i >= 0; i-- {
		v = v<<8 | uintptr(r.b[r.off+i])
	}
	r.off += n
	return v
}

func (r *reader) str() string {
	p := r.ptr()
	if p == 0 {
		return ""
	}
	return windows.UTF16PtrToString(osString(p))
}

// parsed is TASKDIALOGCONFIG (commctrl.h), field by field, in declaration order.
type parsed struct {
	size                                uint32
	hwndParent, hinst                   uintptr
	flags, common                       uint32
	title                               string
	iconPtr                             uintptr
	iconName                            string
	instruction, content                string
	nButtons                            uint32
	buttons                             uintptr
	defaultButton                       int32
	nRadios                             uint32
	radios                              uintptr
	defaultRadio                        int32
	verification                        uintptr
	expanded, expandedCtl, collapsedCtl string
	footerIcon                          uintptr
	footer                              string
	callback, callbackData              uintptr
	width                               uint32
	length                              int
	buttonTexts, radioTexts             []string
	buttonIDs, radioIDs                 []int32
}

func parse(cfg []byte, icon Icon) parsed {
	r := &reader{b: cfg}
	var c parsed
	c.length = len(cfg)
	c.size, c.hwndParent, c.hinst, c.flags, c.common = r.u32(), r.ptr(), r.ptr(), r.u32(), r.u32()
	c.title = r.str()
	c.iconPtr = r.ptr()
	if icon == IconApp && c.iconPtr != 0 {
		c.iconName = windows.UTF16PtrToString(osString(c.iconPtr))
	}
	c.instruction, c.content = r.str(), r.str()
	c.nButtons, c.buttons = r.u32(), r.ptr()
	c.defaultButton = int32(r.u32())
	c.nRadios, c.radios = r.u32(), r.ptr()
	c.defaultRadio = int32(r.u32())
	c.verification = r.ptr()
	c.expanded, c.expandedCtl, c.collapsedCtl = r.str(), r.str(), r.str()
	c.footerIcon = r.ptr()
	c.footer = r.str()
	c.callback, c.callbackData = r.ptr(), r.ptr()
	c.width = r.u32()
	read := func(arr uintptr, n uint32) (ids []int32, texts []string) {
		if n == 0 {
			return nil, nil
		}
		rr := &reader{b: readMemory(arr, int(n)*(4+int(unsafe.Sizeof(uintptr(0)))))}
		for i := uint32(0); i < n; i++ {
			ids = append(ids, int32(rr.u32()))
			texts = append(texts, rr.str())
		}
		return ids, texts
	}
	c.buttonIDs, c.buttonTexts = read(c.buttons, c.nButtons)
	c.radioIDs, c.radioTexts = read(c.radios, c.nRadios)
	return c
}

func TestConfigBytes(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("the layout below is the 64-bit one")
	}
	d := &Dialog{
		Title: "Instalador do Telinha", Instruction: "Telinha para Discord", Content: "Conteúdo", Icon: IconApp,
		Buttons: []Button{{ID: 101, Text: "Instalar\nx"}, {ID: 102, Text: "Desinstalar"}}, Common: BtnCancel, Default: 101,
		CommandLinks: true, Links: true, Radios: []Button{{ID: 200, Text: "Todos"}, {ID: 201, Text: "Só um"}}, DefaultRadio: 200,
		Expanded: "detalhes", Footer: "rodapé",
	}
	p := &packer{}
	cfg := d.config(p, 0, true)
	c := parse(cfg, d.Icon)
	if c.size != 160 || c.length != 160 {
		t.Fatalf("cbSize %d, bytes %d: TASKDIALOGCONFIG is 160 bytes packed on 64-bit", c.size, c.length)
	}
	if c.hwndParent != 0 || c.verification != 0 || c.footerIcon != 0 || c.callbackData != 0 || c.width != 0 {
		t.Fatalf("fields that must stay empty: %+v", c)
	}
	if c.hinst == 0 || c.iconName != "APP" {
		t.Fatalf("the app icon is the APP resource of this module: hinst %#x icon %q", c.hinst, c.iconName)
	}
	for _, want := range []uint32{tdfUseCommandLinks, tdfEnableHyperlinks, tdfAllowCancel, tdfSizeToContent} {
		if c.flags&want == 0 {
			t.Errorf("flags %#x lack %#x", c.flags, want)
		}
	}
	if c.common != BtnCancel || c.title != d.Title || c.instruction != d.Instruction || c.content != d.Content {
		t.Errorf("texts/common: %+v", c)
	}
	if c.expanded != "detalhes" || c.expandedCtl != "Ocultar detalhes" || c.collapsedCtl != "Ver detalhes" || c.footer != "rodapé" {
		t.Errorf("expanded/footer: %q %q %q %q", c.expanded, c.expandedCtl, c.collapsedCtl, c.footer)
	}
	if c.nButtons != 2 || c.defaultButton != 101 || c.buttonIDs[0] != 101 || c.buttonIDs[1] != 102 || c.buttonTexts[0] != "Instalar\nx" || c.buttonTexts[1] != "Desinstalar" {
		t.Errorf("buttons: %+v", c)
	}
	if c.nRadios != 2 || c.defaultRadio != 200 || c.radioIDs[1] != 201 || c.radioTexts[1] != "Só um" {
		t.Errorf("radios: %+v", c)
	}
	if c.callback != callback {
		t.Errorf("callback %#x, want the process-wide one %#x", c.callback, callback)
	}
	if len(p.keep) == 0 {
		t.Error("nothing kept alive")
	}
}

func TestConfigVariants(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("the layout below is the 64-bit one")
	}
	// a system icon, no handler, no links, no command links, extra flags passed in
	d := &Dialog{Title: "t", Instruction: "i", Icon: IconError, Common: BtnClose | BtnOK}
	p := &packer{}
	defer runtime.KeepAlive(p)
	c := parse(d.config(p, tdfShowMarqueeProgress, false), d.Icon)
	if c.hinst != 0 || c.iconPtr != 0xFFFE {
		t.Errorf("system icon: hinst %#x icon %#x", c.hinst, c.iconPtr)
	}
	if c.callback != 0 {
		t.Errorf("handler=false must not install the callback: %#x", c.callback)
	}
	if c.flags&(tdfUseCommandLinks|tdfEnableHyperlinks) != 0 || c.flags&tdfShowMarqueeProgress == 0 || c.flags&tdfAllowCancel == 0 {
		t.Errorf("flags %#x", c.flags)
	}
	if c.nButtons != 0 || c.buttons != 0 || c.nRadios != 0 || c.radios != 0 || c.expanded != "" || c.footer != "" || c.content != "" {
		t.Errorf("empty parts must be NULL: %+v", c)
	}

	// OK/Yes/No buttons alone do not allow closing with the X (no tdfAllowCancel)
	p2 := &packer{}
	defer runtime.KeepAlive(p2)
	c = parse((&Dialog{Instruction: "i", Icon: IconInfo, Common: BtnOK}).config(p2, 0, true), IconInfo)
	if c.flags&tdfAllowCancel != 0 || c.iconPtr != 0xFFFD {
		t.Errorf("flags %#x icon %#x", c.flags, c.iconPtr)
	}
}

// ---------------------------------------------------------------------------------------------- Show / run

func TestShowReturnsTheAnswer(t *testing.T) {
	f := install(t, true)
	f.dialogHook = func(cfg []byte, button, radio *int32) uintptr {
		c := parse(cfg, IconWarning)
		if c.instruction != "Fechar agora?" || c.nButtons != 1 {
			t.Errorf("the dialog that reached Windows: %+v", c)
		}
		if handlerNow() == nil {
			t.Error("no handler registered while the dialog is open")
		}
		*button, *radio = 103, 201
		return 0
	}
	b, r := Show(Dialog{Title: "t", Instruction: "Fechar agora?", Icon: IconWarning, Buttons: []Button{{ID: 103, Text: "Sim"}}})
	if b != 103 || r != 201 {
		t.Fatalf("got button %d radio %d", b, r)
	}
	if handlerNow() != nil {
		t.Fatal("the handler stayed registered after the dialog closed")
	}
	if !f.logged("dialog: Fechar agora?") || !f.logged("dialog answer: button=103 radio=201") {
		t.Fatalf("log: %v", f.logs)
	}
}

func TestShowWithoutLogger(t *testing.T) {
	f := install(t, true)
	Logf = nil
	f.dialogHook = func(_ []byte, button, _ *int32) uintptr { *button = IDOK; return 0 }
	if b, _ := Show(Dialog{Instruction: "x", Common: BtnOK}); b != IDOK {
		t.Fatalf("button %d", b)
	}
}

func TestShowFallsBackWhenTheDialogFails(t *testing.T) {
	f := install(t, true)
	f.boxAnswer = IDYES
	f.dialogHook = func(_ []byte, _, _ *int32) uintptr { return 0x80004005 } // E_FAIL-like: negative HRESULT
	b, r := Show(Dialog{Title: "t", Instruction: "Instalar?", Buttons: []Button{{ID: 101, Text: "Instalar"}, {ID: 102, Text: "Sair"}}, DefaultRadio: 7})
	if b != 101 || r != 7 {
		t.Fatalf("button %d radio %d: a failed dialog must fall back to a message box and keep the default radio", b, r)
	}
	if len(f.boxes) != 1 || f.logged("dialog answer") {
		t.Fatalf("boxes %v logs %v", f.boxes, f.logs)
	}
}

func TestShowWithoutTaskDialogs(t *testing.T) {
	f := install(t, false)
	f.boxAnswer = IDOK
	b, r := Show(Dialog{Title: "Telinha", Instruction: "Pronto", Content: "Feche o Discord.", Common: BtnClose})
	if b != IDOK || r != 0 || f.dialogs != 0 || len(f.boxes) != 1 {
		t.Fatalf("button %d radio %d, %d task dialogs, %d boxes", b, r, f.dialogs, len(f.boxes))
	}
	if got := f.boxes[0]; got.text != "Pronto\n\nFeche o Discord." || got.caption != "Telinha" || got.style != mbOK|mbIconInfo {
		t.Fatalf("box %+v", got)
	}
	if !f.logged("dialog: Pronto") {
		t.Fatal("the dialog was not logged")
	}
}

func TestHyperlinks(t *testing.T) {
	f := install(t, true)
	f.dialogHook = func(_ []byte, button, _ *int32) uintptr {
		h := handlerNow()
		for _, url := range []string{"https://github.com/HumbertoFernandes7/Telinha", "http://insecure.example", "file:///c:/x", "ftp://x"} {
			u, _ := windows.UTF16PtrFromString(url)
			if r := h(1, tdnHyperlinkClicked, 0, uintptr(unsafe.Pointer(u))); r != 0 {
				t.Errorf("hyperlink handler returned %d", r)
			}
			runtime.KeepAlive(u) // the handler reads the string through the raw address
		}
		if r := h(1, tdnHyperlinkClicked, 0, 0); r != 0 { // NULL link: nothing to open
			t.Errorf("NULL hyperlink returned %d", r)
		}
		if r := h(1, tdnCreated, 0, 0); r != 0 { // any other notification: ignored
			t.Errorf("created returned %d", r)
		}
		*button = IDOK
		return 0
	}
	Show(Dialog{Instruction: "x", Common: BtnOK, Links: true})
	if len(f.opened) != 1 || f.opened[0] != "https://github.com/HumbertoFernandes7/Telinha" {
		t.Fatalf("opened %v: only https links may be followed", f.opened)
	}
}

func TestAutoClick(t *testing.T) {
	f := install(t, true)
	AutoClick = 50 * time.Millisecond
	var flags uint32
	f.dialogHook = func(cfg []byte, button, _ *int32) uintptr {
		flags = parse(cfg, IconApp).flags
		h := handlerNow()
		h(77, tdnTimer, 10, 0)  // too early
		h(77, tdnTimer, 49, 0)  // still too early
		h(77, tdnTimer, 60, 0)  // time: click the default button
		h(77, tdnTimer, 120, 0) // only once
		h(77, tdnCreated, 0, 0)
		*button = 101
		return 0
	}
	Show(Dialog{Instruction: "x", Buttons: []Button{{ID: 101, Text: "Instalar"}, {ID: 102, Text: "Sair"}}, Common: BtnCancel})
	if flags&tdfCallbackTimer == 0 {
		t.Fatalf("auto-click needs the timer: flags %#x", flags)
	}
	if clicks := f.clicks(); len(clicks) != 1 || clicks[0] != 101 {
		t.Fatalf("clicks %v, want one on the default button 101", clicks)
	}
	if m := f.sentMsgs()[0]; m.hwnd != 77 || m.wparam != 101 {
		t.Fatalf("message %+v", m)
	}
}

func TestNoAutoClickByDefault(t *testing.T) {
	f := install(t, true)
	var flags uint32
	f.dialogHook = func(cfg []byte, button, _ *int32) uintptr {
		flags = parse(cfg, IconApp).flags
		handlerNow()(1, tdnTimer, 100000, 0)
		*button = IDCANCEL
		return 0
	}
	Show(Dialog{Instruction: "x", Common: BtnCancel})
	if flags&tdfCallbackTimer != 0 || len(f.clicks()) != 0 {
		t.Fatalf("flags %#x clicks %v", flags, f.clicks())
	}
}

// the one native trampoline Windows calls: it forwards to whatever dialog is open and ignores the rest
func TestNativeCallback(t *testing.T) {
	activeMu.Lock()
	old := activeHandler
	activeHandler = nil
	activeMu.Unlock()
	t.Cleanup(func() {
		activeMu.Lock()
		activeHandler = old
		activeMu.Unlock()
	})
	if r, _, _ := syscall.SyscallN(callback, 1, tdnCreated, 0, 0, 0); r != 0 {
		t.Fatalf("no dialog open: %d", r)
	}
	var got [4]uintptr
	activeMu.Lock()
	activeHandler = func(hwnd, msg, wparam, lparam uintptr) uintptr {
		got = [4]uintptr{hwnd, msg, wparam, lparam}
		return 42
	}
	activeMu.Unlock()
	if r, _, _ := syscall.SyscallN(callback, 11, 22, 33, 44, 55); r != 42 || got != [4]uintptr{11, 22, 33, 44} {
		t.Fatalf("result %d args %v", r, got)
	}
}

// ---------------------------------------------------------------------------------------------- fallback

func TestFallbackMessageBox(t *testing.T) {
	type tc struct {
		name    string
		d       Dialog
		answer  int
		want    int
		text    string
		style   uint32
		caption string
	}
	two := []Button{{ID: 101, Text: "Instalar\nBaixa e ativa."}, {ID: 102, Text: "Desinstalar\nRemove."}, {ID: 103, Text: "Terceiro"}}
	for _, c := range []tc{
		{"plain info", Dialog{Title: "T", Instruction: "Oi"}, IDOK, IDOK, "Oi", mbOK | mbIconInfo, "T"},
		{"content", Dialog{Instruction: "Oi", Content: "Mais."}, IDOK, IDOK, "Oi\n\nMais.", mbOK | mbIconInfo, ""},
		{"error icon", Dialog{Instruction: "x", Icon: IconError}, IDOK, IDOK, "x", mbOK | mbIconError, ""},
		{"warning icon", Dialog{Instruction: "x", Icon: IconWarning}, IDOK, IDOK, "x", mbOK | mbIconWarning, ""},
		{"app icon is info", Dialog{Instruction: "x", Icon: IconApp}, IDOK, IDOK, "x", mbOK | mbIconInfo, ""},
		{"shield icon is info", Dialog{Instruction: "x", Icon: IconShield}, IDOK, IDOK, "x", mbOK | mbIconInfo, ""},
		{"buttons: yes is the first", Dialog{Instruction: "Escolha", Buttons: two}, IDYES, 101,
			"Escolha\n\nSim = Instalar\nNão = Desinstalar", mbYesNoCancel | mbIconInfo, ""},
		{"buttons: no is the second", Dialog{Instruction: "Escolha", Buttons: two}, IDNO, 102,
			"Escolha\n\nSim = Instalar\nNão = Desinstalar", mbYesNoCancel | mbIconInfo, ""},
		{"buttons: cancel", Dialog{Instruction: "Escolha", Buttons: two}, IDCANCEL, IDCANCEL,
			"Escolha\n\nSim = Instalar\nNão = Desinstalar", mbYesNoCancel | mbIconInfo, ""},
		{"one button: no means cancel", Dialog{Instruction: "Fechar?", Content: "c", Buttons: two[:1], Icon: IconWarning}, IDNO, IDCANCEL,
			"Fechar?\n\nc\n\nSim = Instalar", mbYesNoCancel | mbIconWarning, ""},
		{"one button: yes", Dialog{Instruction: "Fechar?", Buttons: two[:1]}, IDYES, 101, "Fechar?\n\nSim = Instalar", mbYesNoCancel | mbIconInfo, ""},
	} {
		f := install(t, false)
		f.boxAnswer = c.answer
		if got := fallback(&c.d); got != c.want {
			t.Errorf("%s: returned %d, want %d", c.name, got, c.want)
		}
		if len(f.boxes) != 1 || f.boxes[0].text != c.text || f.boxes[0].style != c.style || f.boxes[0].caption != c.caption {
			t.Errorf("%s: box %+v, want text %q style %#x caption %q", c.name, f.boxes, c.text, c.style, c.caption)
		}
	}
}

func TestOpenURLOnlyFollowsHTTPS(t *testing.T) {
	f := install(t, true)
	for _, u := range []string{"", "https:/", "http://x.example", "HTTPS://x.example", "javascript:alert(1)", "file:///c:/windows/system32/calc.exe", "calc.exe", "ms-settings:"} {
		OpenURL(u)
	}
	if len(f.opened) != 0 {
		t.Fatalf("opened %v", f.opened)
	}
	OpenURL("https://vencord.dev/download/")
	if len(f.opened) != 1 || f.opened[0] != "https://vencord.dev/download/" {
		t.Fatalf("opened %v", f.opened)
	}
}

// the real probes: harmless to call (nothing is shown, nothing is launched)
func TestRealProbes(t *testing.T) {
	_ = Available() // true only when comctl32 v6 is loaded (the installer's manifest); this test binary has none
	if r := sendMessage(0, 0, 0, 0); r != 0 {
		t.Fatalf("WM_NULL to no window: %d", r)
	}
}

// ---------------------------------------------------------------------------------------------- Progress

func TestProgressWithoutTaskDialogs(t *testing.T) {
	install(t, false)
	want := errors.New("download failed")
	var texts []string
	start := time.Now()
	err := Progress("t", "Instalando", nil, func(set func(string)) error {
		set("um")
		texts = append(texts, "um")
		time.Sleep(30 * time.Millisecond)
		return want
	})
	if err != want {
		t.Fatalf("err %v", err)
	}
	if time.Since(start) < 30*time.Millisecond || len(texts) != 1 {
		t.Fatalf("did not wait for the work: %v", time.Since(start))
	}
	if err := Progress("t", "Instalando", func() {}, func(func(string)) error { return nil }); err != nil {
		t.Fatalf("ok work: %v", err)
	}
}

// drive plays the part of the dialog's message loop for Progress: it sends WM_TIMER-like notifications until
// Windows would have been told to click a button, then lets the click arrive.
func drive(t *testing.T, f *fakeOS, h func(hwnd, msg, wparam, lparam uintptr) uintptr, beforeTick func(i int)) {
	t.Helper()
	if r := h(9, tdnCreated, 0, 0); r != 0 {
		t.Errorf("created returned %d", r)
	}
	for i := 0; i < 3000; i++ {
		if beforeTick != nil {
			beforeTick(i)
		}
		h(9, tdnTimer, uintptr(i*10), 0)
		if len(f.clicks()) > 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("Progress never asked to close the dialog")
}

func textsSent(f *fakeOS) (out []string) {
	for _, m := range f.sentMsgs() {
		if m.msg == tdmSetElementText {
			out = append(out, m.text)
		}
	}
	return out
}

func TestProgressRunsUntilTheWorkEnds(t *testing.T) {
	f := install(t, true)
	gate := make(chan struct{})
	started := make(chan struct{})
	want := errors.New("boom")
	var cfgSeen parsed
	f.dialogHook = func(cfg []byte, button, _ *int32) uintptr {
		cfgSeen = parse(cfg, IconApp)
		released := false
		drive(t, f, handlerNow(), func(int) {
			select {
			case <-started:
			default:
				return
			}
			for _, txt := range textsSent(f) {
				if txt == "Baixando…" && !released {
					released = true
					close(gate)
				}
			}
		})
		// the user clicks while it is closing: allowed through
		if r := handlerNow()(9, tdnButtonClicked, uintptr(IDCLOSE), 0); r != 0 {
			t.Errorf("click on the closing dialog returned %d", r)
		}
		*button = IDCLOSE
		return 0
	}
	err := Progress("Instalador", "Instalando o Telinha", nil, func(set func(string)) error {
		set("Baixando…")
		close(started)
		<-gate
		set("Quase lá")
		return want
	})
	if err != want {
		t.Fatalf("Progress returned %v, want the work's error", err)
	}
	if cfgSeen.instruction != "Instalando o Telinha" || cfgSeen.content != " " || cfgSeen.common != BtnClose {
		t.Errorf("dialog: %+v (no cancel func: only Close)", cfgSeen)
	}
	if cfgSeen.flags&tdfShowMarqueeProgress == 0 || cfgSeen.flags&tdfCallbackTimer == 0 {
		t.Errorf("flags %#x lack marquee/timer", cfgSeen.flags)
	}
	msgs := f.sentMsgs()
	if msgs[0].msg != tdmSetProgressMarquee || msgs[0].wparam != 1 || msgs[0].lparam != 30 {
		t.Errorf("first message %+v, want the marquee to start", msgs[0])
	}
	texts := textsSent(f) // the first tick may already find "Baixando…" instead of the initial blank
	if len(texts) < 2 || texts[len(texts)-2] != "Baixando…" || texts[len(texts)-1] != "Quase lá" {
		t.Errorf("texts %q: every change of the work's text must reach the dialog, in order", texts)
	}
	if clicks := f.clicks(); len(clicks) != 1 || clicks[0] != IDCLOSE {
		t.Errorf("clicks %v, want one on Close", clicks)
	}
}

func TestProgressCancel(t *testing.T) {
	f := install(t, true)
	cancelled := make(chan struct{})
	cancels := 0
	cancel := func() { cancels++; close(cancelled) }
	f.dialogHook = func(cfg []byte, button, _ *int32) uintptr {
		if c := parse(cfg, IconApp); c.common != BtnCancel || c.flags&tdfAllowCancel == 0 {
			t.Errorf("a cancellable dialog needs the Cancel button: %+v", c)
		}
		h := handlerNow()
		h(9, tdnCreated, 0, 0)
		h(9, tdnTimer, 0, 0)
		// the user clicks Cancelar: the click is refused (the dialog stays until the work returns) and cancel runs once
		if r := h(9, tdnButtonClicked, uintptr(IDCANCEL), 0); r != sFalse {
			t.Errorf("first click returned %d, want the dialog to stay open", r)
		}
		if r := h(9, tdnButtonClicked, uintptr(IDCANCEL), 0); r != sFalse {
			t.Errorf("second click returned %d", r)
		}
		drive(t, f, h, nil)
		*button = IDCANCEL
		return 0
	}
	err := Progress("t", "Instalando", cancel, func(set func(string)) error {
		<-cancelled
		return errors.New("cancelled")
	})
	if err == nil || err.Error() != "cancelled" {
		t.Fatalf("err %v", err)
	}
	if cancels != 1 {
		t.Fatalf("cancel called %d times", cancels)
	}
	texts := textsSent(f)
	if len(texts) < 2 || texts[len(texts)-1] != "Cancelando…" {
		t.Fatalf("texts %q: the user must see that it is cancelling", texts)
	}
	if clicks := f.clicks(); len(clicks) != 1 || clicks[0] != IDCANCEL {
		t.Fatalf("clicks %v", clicks)
	}
}

func TestProgressClickWithoutCancelStaysOpen(t *testing.T) {
	f := install(t, true)
	gate := make(chan struct{})
	f.dialogHook = func(_ []byte, button, _ *int32) uintptr {
		h := handlerNow()
		h(9, tdnCreated, 0, 0)
		if r := h(9, tdnButtonClicked, uintptr(IDCLOSE), 0); r != sFalse {
			t.Errorf("click returned %d: the dialog must stay while the work runs", r)
		}
		close(gate)
		drive(t, f, h, nil)
		*button = IDCLOSE
		return 0
	}
	if err := Progress("t", "Fechando", nil, func(func(string)) error { <-gate; return nil }); err != nil {
		t.Fatal(err)
	}
	if len(textsSent(f)) != 1 { // only the initial " ": nothing says "Cancelando"
		t.Fatalf("texts %q", textsSent(f))
	}
	if h := handlerNow(); h != nil {
		t.Fatal("handler left registered")
	}
	// ignoring notifications it does not know
}

func TestProgressDialogError(t *testing.T) {
	f := install(t, true)
	f.dialogHook = func(_ []byte, _, _ *int32) uintptr { return 0x80070057 } // E_INVALIDARG
	boom := errors.New("work failed")
	err := Progress("t", "x", nil, func(func(string)) error { time.Sleep(20 * time.Millisecond); return boom })
	if !errors.Is(err, boom) {
		t.Fatalf("the work's error must survive a dialog failure: %v", err)
	}
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		t.Fatalf("the dialog's own error is lost: %v", err)
	}
	// and when the work succeeded the dialog error alone is reported
	err = Progress("t", "x", nil, func(func(string)) error { return nil })
	if err == nil || errors.Is(err, boom) {
		t.Fatalf("err %v", err)
	}
}

func TestProgressUnknownNotificationsAreIgnored(t *testing.T) {
	f := install(t, true)
	f.dialogHook = func(_ []byte, button, _ *int32) uintptr {
		h := handlerNow()
		for _, msg := range []uintptr{1, 5, 6, 9, 100} {
			if r := h(9, msg, 0, 0); r != 0 {
				t.Errorf("notification %d returned %d", msg, r)
			}
		}
		h(9, tdnCreated, 0, 0)
		drive(t, f, h, nil)
		*button = IDCLOSE
		return 0
	}
	if err := Progress("t", "x", nil, func(func(string)) error { return nil }); err != nil {
		t.Fatal(err)
	}
}
