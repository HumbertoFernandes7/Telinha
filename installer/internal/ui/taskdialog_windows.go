// SPDX-License-Identifier: GPL-3.0-or-later

// Package ui shows native Windows dialogs (TaskDialogIndirect from comctl32 v6, enabled by the
// application manifest in the .syso; MessageBoxW as a fallback). Pure Go, no cgo.
package ui

import (
	"encoding/binary"
	"errors"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Icon is the dialog's main icon.
type Icon int

const (
	IconApp Icon = iota
	IconInfo
	IconWarning
	IconError
	IconShield
)

// Standard button IDs (returned by Show).
const (
	IDOK     = 1
	IDCANCEL = 2
	IDYES    = 6
	IDNO     = 7
	IDCLOSE  = 8
)

// Common buttons (Dialog.Common).
const (
	BtnOK     = 0x01
	BtnYes    = 0x02
	BtnNo     = 0x04
	BtnCancel = 0x08
	BtnClose  = 0x20
)

// Button is a custom button. With CommandLinks, "Title\nexplanation" shows the explanation underneath.
type Button struct {
	ID   int
	Text string
}

// Dialog describes one task dialog.
type Dialog struct {
	Title        string // window caption
	Instruction  string // main instruction (large text)
	Content      string
	Icon         Icon
	Buttons      []Button
	Common       int // Btn* flags
	Default      int // default button ID
	CommandLinks bool
	Radios       []Button
	DefaultRadio int
	Expanded     string // collapsible "Detalhes"
	Footer       string
	Links        bool // <a href="https://...">text</a> in Content/Footer opens the browser
}

var (
	comctl32               = windows.NewLazySystemDLL("comctl32.dll")
	procTaskDialogIndirect = comctl32.NewProc("TaskDialogIndirect")
	user32                 = windows.NewLazySystemDLL("user32.dll")
	procMessageBox         = user32.NewProc("MessageBoxW")
	procSendMessage        = user32.NewProc("SendMessageW")
)

const (
	tdfEnableHyperlinks            = 0x0001
	tdfAllowCancel                 = 0x0008
	tdfUseCommandLinks             = 0x0010
	tdfShowMarqueeProgress         = 0x0400
	tdfCallbackTimer               = 0x0800
	tdfSizeToContent               = 0x01000000
	tdnCreated                     = 0
	tdnButtonClicked               = 2
	tdnHyperlinkClicked            = 3
	tdnTimer                       = 4
	wmUser                         = 0x0400
	tdmClickButton                 = wmUser + 102
	tdmSetProgressMarquee          = wmUser + 107
	tdmSetElementText              = wmUser + 108
	tdeContent                     = 0
	tdeMainInstruction             = 3
	mbYesNoCancel                  = 0x03
	mbOK                           = 0x00
	mbIconError                    = 0x10
	mbIconWarning                  = 0x30
	mbIconInfo                     = 0x40
	mbSetForeground                = 0x10000
	sFalse                 uintptr = 1
)

// one callback for the whole process (syscall.NewCallback slots are never freed); dialogs are modal, so
// the active handler is just a variable.
var (
	activeMu      sync.Mutex
	activeHandler func(hwnd, msg, wparam, lparam uintptr) uintptr
	callback      = syscall.NewCallback(func(hwnd, msg, wparam, lparam, _ uintptr) uintptr {
		activeMu.Lock()
		h := activeHandler
		activeMu.Unlock()
		if h != nil {
			return h(hwnd, msg, wparam, lparam)
		}
		return 0
	})
)

func init() { runtime.LockOSThread() } // UI calls stay on the main thread

// Available reports whether TaskDialogIndirect can be used (comctl32 v6 via the manifest).
func Available() bool { return procTaskDialogIndirect.Find() == nil }

type packer struct {
	b    []byte
	keep []any
}

func (p *packer) u32(v uint32) { p.b = binary.LittleEndian.AppendUint32(p.b, v) }
func (p *packer) ptr(v uintptr) {
	if unsafe.Sizeof(v) == 8 {
		p.b = binary.LittleEndian.AppendUint64(p.b, uint64(v))
	} else {
		p.b = binary.LittleEndian.AppendUint32(p.b, uint32(v))
	}
}
func (p *packer) str(s string) uintptr {
	if s == "" {
		return 0
	}
	u, err := windows.UTF16PtrFromString(s)
	if err != nil {
		u, _ = windows.UTF16PtrFromString("?")
	}
	p.keep = append(p.keep, u)
	return uintptr(unsafe.Pointer(u))
}

// buttons builds a packed TASKDIALOG_BUTTON array (commctrl.h uses #pragma pack(1)).
func (p *packer) buttons(bs []Button) uintptr {
	if len(bs) == 0 {
		return 0
	}
	sub := &packer{}
	for _, b := range bs {
		sub.u32(uint32(int32(b.ID)))
		sub.ptr(p.str(b.Text))
	}
	p.keep = append(p.keep, sub.b)
	return uintptr(unsafe.Pointer(&sub.b[0]))
}

func iconRes(i Icon) uintptr {
	switch i {
	case IconWarning:
		return 0xFFFF // TD_WARNING_ICON
	case IconError:
		return 0xFFFE // TD_ERROR_ICON
	case IconInfo:
		return 0xFFFD // TD_INFORMATION_ICON
	case IconShield:
		return 0xFFFC // TD_SHIELD_ICON
	}
	return 0
}

func (d *Dialog) config(p *packer, flags uint32, handler bool) []byte {
	hinst := uintptr(0)
	icon := iconRes(d.Icon)
	if d.Icon == IconApp {
		var h windows.Handle
		_ = windows.GetModuleHandleEx(0, nil, &h)
		hinst = uintptr(h)
		icon = p.str("APP") // RT_GROUP_ICON "APP" from winres.json
	}
	if d.CommandLinks {
		flags |= tdfUseCommandLinks
	}
	if d.Links {
		flags |= tdfEnableHyperlinks
	}
	if d.Common&(BtnCancel|BtnClose) != 0 {
		flags |= tdfAllowCancel
	}
	flags |= tdfSizeToContent
	cb := uintptr(0)
	if handler {
		cb = callback
	}
	pb, pr := p.buttons(d.Buttons), p.buttons(d.Radios)
	start := len(p.b)
	p.u32(0) // cbSize, patched below
	p.ptr(0) // hwndParent
	p.ptr(hinst)
	p.u32(flags)
	p.u32(uint32(d.Common))
	p.ptr(p.str(d.Title))
	p.ptr(icon)
	p.ptr(p.str(d.Instruction))
	p.ptr(p.str(d.Content))
	p.u32(uint32(len(d.Buttons)))
	p.ptr(pb)
	p.u32(uint32(int32(d.Default)))
	p.u32(uint32(len(d.Radios)))
	p.ptr(pr)
	p.u32(uint32(int32(d.DefaultRadio)))
	p.ptr(0) // verification text
	p.ptr(p.str(d.Expanded))
	p.ptr(p.str("Ocultar detalhes"))
	p.ptr(p.str("Ver detalhes"))
	p.ptr(0) // footer icon
	p.ptr(p.str(d.Footer))
	p.ptr(cb)
	p.ptr(0) // lpCallbackData
	p.u32(0) // cxWidth
	cfg := p.b[start:]
	binary.LittleEndian.PutUint32(cfg[0:4], uint32(len(cfg)))
	return cfg
}

// Logf, when set, records every dialog shown and its answer (installer.log).
var Logf func(format string, args ...any)

// AutoClick is a test hook for a self-driving smoke run on fake trees: when > 0, every dialog clicks its
// default button by itself after this long (progress dialogs close on their own as usual).
var AutoClick time.Duration

func (d *Dialog) defaultButton() int {
	switch {
	case d.Default != 0:
		return d.Default
	case len(d.Buttons) > 0:
		return d.Buttons[0].ID
	case d.Common&BtnOK != 0:
		return IDOK
	}
	return firstCommon(d.Common)
}

func run(d *Dialog, flags uint32, handler func(hwnd, msg, wparam, lparam uintptr) uintptr) (int, int, error) {
	if Logf != nil {
		Logf("dialog: %s", d.Instruction)
	}
	if !Available() {
		return fallback(d), 0, nil
	}
	auto := AutoClick > 0 && handler == nil
	if auto {
		flags |= tdfCallbackTimer
	}
	autoDone := false
	p := &packer{}
	cfg := d.config(p, flags, true)
	activeMu.Lock()
	activeHandler = func(hwnd, msg, wparam, lparam uintptr) uintptr {
		if msg == tdnHyperlinkClicked && lparam != 0 {
			OpenURL(windows.UTF16PtrToString(osString(lparam)))
			return 0
		}
		if auto && msg == tdnTimer && !autoDone && time.Duration(wparam)*time.Millisecond >= AutoClick {
			autoDone = true
			procSendMessage.Call(hwnd, tdmClickButton, uintptr(d.defaultButton()), 0)
			return 0
		}
		if handler != nil {
			return handler(hwnd, msg, wparam, lparam)
		}
		return 0
	}
	activeMu.Unlock()
	defer func() {
		activeMu.Lock()
		activeHandler = nil
		activeMu.Unlock()
	}()
	var button, radio int32
	hr, _, _ := procTaskDialogIndirect.Call(uintptr(unsafe.Pointer(&cfg[0])), uintptr(unsafe.Pointer(&button)), uintptr(unsafe.Pointer(&radio)), 0)
	runtime.KeepAlive(p)
	runtime.KeepAlive(cfg)
	if int32(hr) < 0 {
		return 0, 0, syscall.Errno(hr)
	}
	if Logf != nil {
		Logf("dialog answer: button=%d radio=%d", button, radio)
	}
	return int(button), int(radio), nil
}

// osString turns a PCWSTR handed to us by Windows (not Go memory) into a pointer without tripping vet's
// uintptr->unsafe.Pointer check.
func osString(p uintptr) *uint16 { return *(**uint16)(unsafe.Pointer(&p)) }

// Show displays the dialog and returns the clicked button ID and the selected radio ID.
func Show(d Dialog) (button, radio int) {
	b, r, err := run(&d, 0, nil)
	if err != nil {
		return fallback(&d), d.DefaultRadio
	}
	return b, r
}

func fallback(d *Dialog) int {
	text := d.Instruction
	if d.Content != "" {
		text += "\n\n" + d.Content
	}
	style := uint32(mbOK)
	if len(d.Buttons) > 0 {
		style = mbYesNoCancel
		text += "\n"
		for i, b := range d.Buttons {
			if i < 2 {
				text += "\n" + []string{"Sim", "Não"}[i] + " = " + firstLine(b.Text)
			}
		}
	}
	switch d.Icon {
	case IconError:
		style |= mbIconError
	case IconWarning:
		style |= mbIconWarning
	default:
		style |= mbIconInfo
	}
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString(d.Title)
	r, _, _ := procMessageBox.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), uintptr(style|mbSetForeground))
	if len(d.Buttons) > 0 {
		switch r {
		case IDYES:
			return d.Buttons[0].ID
		case IDNO:
			if len(d.Buttons) > 1 {
				return d.Buttons[1].ID
			}
		}
		return IDCANCEL
	}
	return int(r)
}

func firstLine(s string) string {
	for i, r := range s {
		if r == '\n' {
			return s[:i]
		}
	}
	return s
}

// Progress shows a marquee progress dialog while work runs in the background. work gets a function to
// update the text. If cancel is not nil the dialog has a Cancelar button that calls it (work should then
// return soon). Returns work's error.
func Progress(title, instruction string, cancel func(), work func(set func(string)) error) error {
	var (
		mu       sync.Mutex
		text     = " "
		changed  = true
		finished bool
		result   error
	)
	set := func(s string) {
		mu.Lock()
		text, changed = s, true
		mu.Unlock()
	}
	go func() {
		err := work(set)
		mu.Lock()
		finished, result = true, err
		mu.Unlock()
	}()
	if !Available() {
		for {
			mu.Lock()
			f := finished
			mu.Unlock()
			if f {
				return result
			}
			time.Sleep(100 * time.Millisecond)
		}
	}

	d := &Dialog{Title: title, Instruction: instruction, Content: " ", Icon: IconApp}
	if cancel != nil {
		d.Common = BtnCancel
	} else {
		d.Common = BtnClose
	}
	var textBuf []*uint16
	closing, cancelled := false, false
	handler := func(hwnd, msg, wparam, _ uintptr) uintptr {
		switch msg {
		case tdnCreated:
			procSendMessage.Call(hwnd, tdmSetProgressMarquee, 1, 30)
		case tdnTimer:
			mu.Lock()
			t, ch, f := text, changed, finished
			changed = false
			mu.Unlock()
			if ch {
				u, _ := windows.UTF16PtrFromString(t)
				textBuf = append(textBuf, u) // must outlive the call
				procSendMessage.Call(hwnd, tdmSetElementText, tdeContent, uintptr(unsafe.Pointer(u)))
			}
			if f && !closing {
				closing = true
				procSendMessage.Call(hwnd, tdmClickButton, uintptr(firstCommon(d.Common)), 0)
			}
		case tdnButtonClicked:
			if closing {
				return 0
			}
			if cancel != nil && !cancelled {
				cancelled = true
				cancel()
				u, _ := windows.UTF16PtrFromString("Cancelando…")
				textBuf = append(textBuf, u)
				procSendMessage.Call(hwnd, tdmSetElementText, tdeContent, uintptr(unsafe.Pointer(u)))
			}
			return sFalse // stay open until work returns
		}
		return 0
	}
	if _, _, err := run(d, tdfShowMarqueeProgress|tdfCallbackTimer, handler); err != nil {
		return errors.Join(err, waitDone(&mu, &finished, &result))
	}
	runtime.KeepAlive(textBuf)
	return waitDone(&mu, &finished, &result)
}

func waitDone(mu *sync.Mutex, finished *bool, result *error) error {
	for {
		mu.Lock()
		f, r := *finished, *result
		mu.Unlock()
		if f {
			return r
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func firstCommon(c int) int {
	switch {
	case c&BtnCancel != 0:
		return IDCANCEL
	case c&BtnClose != 0:
		return IDCLOSE
	}
	return IDOK
}

// OpenURL opens an https URL in the default browser.
func OpenURL(url string) {
	if len(url) < 8 || url[:8] != "https://" {
		return
	}
	verb, _ := windows.UTF16PtrFromString("open")
	u, _ := windows.UTF16PtrFromString(url)
	_ = windows.ShellExecute(0, verb, u, nil, nil, windows.SW_SHOWNORMAL)
}
