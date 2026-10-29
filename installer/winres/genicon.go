// SPDX-License-Identifier: GPL-3.0-or-later

//go:build ignore

// genicon builds every Telinha icon PNG from one master artwork: the kawaii TV mascot in
// ../assets/telinha-icon-1024.png (1024x1024, transparent corners). Nothing is drawn by hand any
// more; each size is a high-quality downscale of the master (Lanczos-3 on premultiplied alpha,
// edge-clamped), and the small sizes get a light unsharp mask so the eyes and the outline survive.
//
// Run it from installer/:
//
//	go run winres/genicon.go                     rewrite winres/icon{256,64,48,32,24,16}.png and
//	                                             ../assets/telinha-icon-256.png (README) from the master
//	go run winres/genicon.go -original art.png   first rebuild the master from a larger original
//	                                             (cleans the stray low alpha around the shape)
//	go run winres/genicon.go -sheet sheet.png    also write a contact sheet of 16/24/32/48 px (actual
//	                                             size and magnified, on light and dark) to eyeball them
//
// The PNGs are embedded in the exe through winres.json. After regenerating them rebuild the resource
// objects (the command is in build.cmd):
//
//	go run github.com/tc-hib/go-winres@v0.3.3 make --in winres/winres.json --arch amd64,arm64 --out rsrc
package main

import (
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strconv"
)

const (
	masterPath = "../assets/telinha-icon-1024.png"
	readmePath = "../assets/telinha-icon-256.png"
	masterSize = 1024
)

// iconSpec is one icon size and how much to sharpen it after the downscale (sigma in output pixels,
// amount as a multiplier of the high-pass detail; 0 = plain Lanczos).
type iconSpec struct {
	size          int
	sigma, amount float64
}

var specs = []iconSpec{
	{256, 0, 0},
	{64, 0.6, 0.35},
	{48, 0.6, 0.6},
	{32, 0.6, 0.8},
	{24, 0.6, 1.0},
	{16, 0.6, 1.2},
}

func main() {
	original := flag.String("original", "", "rebuild the master from this larger original PNG first")
	sheet := flag.String("sheet", "", "write a 16/24/32/48 contact sheet to this PNG")
	flag.Parse()

	if *original != "" {
		must(buildMaster(*original))
	}
	master, err := loadNRGBA(masterPath)
	must(err)
	if b := master.Bounds(); b.Dx() != masterSize || b.Dy() != masterSize {
		must(fmt.Errorf("%s is %dx%d, want %dx%d", masterPath, b.Dx(), b.Dy(), masterSize, masterSize))
	}
	src := fromNRGBA(master)

	icons := map[int]*image.NRGBA{}
	for _, s := range specs {
		icons[s.size] = renderIcon(src, s)
		must(writePNG(filepath.Join("winres", "icon"+strconv.Itoa(s.size)+".png"), icons[s.size]))
	}
	must(writePNG(readmePath, icons[256]))
	if *sheet != "" {
		must(writePNG(*sheet, contactSheet(icons)))
	}
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "genicon:", err)
		os.Exit(1)
	}
}

func renderIcon(src *pimg, s iconSpec) *image.NRGBA {
	out := resample(src, s.size, s.size)
	if s.amount > 0 {
		out = sharpen(out, s.sigma, s.amount)
	}
	return out.toNRGBA()
}

// --- master -----------------------------------------------------------------------------------

// buildMaster turns the original artwork into the 1024x1024 master: the stray alpha is cleaned at the
// original resolution, then it is downscaled once.
func buildMaster(path string) error {
	img, err := loadNRGBA(path)
	if err != nil {
		return err
	}
	cleanAlpha(img)
	return writePNG(masterPath, resample(fromNRGBA(img), masterSize, masterSize).toNRGBA())
}

// cleanAlpha fixes what image generators leave behind on a "transparent" icon: the inside is slightly
// translucent (alpha ~250) and there is a faint speckled halo outside the edge. It keeps the largest
// blob of alpha >= 128 as the shape, makes its inside fully opaque, keeps a 2 px antialiased rim,
// clears everything farther out, and re-colors the rim from the nearest solid pixel so no halo color
// bleeds in.
func cleanAlpha(img *image.NRGBA) {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	idx := func(x, y int) int { return y*w + x }
	a := func(i int) uint8 { return img.Pix[i*4+3] }

	// Largest 4-connected blob with alpha >= 128.
	label := make([]int32, w*h)
	var best, bestSize int32
	var next int32
	for start := 0; start < w*h; start++ {
		if a(start) < 128 || label[start] != 0 {
			continue
		}
		next++
		queue := []int{start}
		label[start] = next
		size := 0
		for len(queue) > 0 {
			i := queue[len(queue)-1]
			queue = queue[:len(queue)-1]
			size++
			x, y := i%w, i/w
			for _, n := range [4][2]int{{x - 1, y}, {x + 1, y}, {x, y - 1}, {x, y + 1}} {
				if n[0] < 0 || n[1] < 0 || n[0] >= w || n[1] >= h {
					continue
				}
				j := idx(n[0], n[1])
				if a(j) >= 128 && label[j] == 0 {
					label[j] = next
					queue = append(queue, j)
				}
			}
		}
		if int32(size) > bestSize {
			best, bestSize = next, int32(size)
		}
	}
	core := make([]bool, w*h)
	for i := range core {
		core[i] = label[i] == best
	}

	// Chebyshev distance across the boundary: for core pixels, to the nearest non-core pixel (inside
	// the image only: the shape touches the image border, which is not an edge); for non-core
	// pixels, to the nearest core pixel.
	inDist := bfsDist(w, h, func(i int) bool { return !core[i] }, func(i int) bool { return core[i] })
	outDist := bfsDist(w, h, func(i int) bool { return core[i] }, func(i int) bool { return !core[i] })

	// Solid pixels (3+ px inside the edge) keep their color and become fully opaque. Everything else
	// within 2 px of the edge keeps a (rescaled) antialiasing alpha but takes the color of the nearest
	// solid pixel; the rest is cleared.
	solid := make([]bool, w*h)
	var queue []int
	colorFrom := make([]int, w*h)
	for i := range solid {
		colorFrom[i] = -1
		if core[i] && inDist[i] >= 3 {
			solid[i] = true
			colorFrom[i] = i
			queue = append(queue, i)
		}
	}
	for head := 0; head < len(queue); head++ { // multi-source BFS: who is nearest to each pixel
		i := queue[head]
		x, y := i%w, i/w
		for dy := -1; dy <= 1; dy++ {
			for dx := -1; dx <= 1; dx++ {
				nx, ny := x+dx, y+dy
				if nx < 0 || ny < 0 || nx >= w || ny >= h {
					continue
				}
				j := idx(nx, ny)
				if colorFrom[j] == -1 && (core[j] || outDist[j] <= 2) {
					colorFrom[j] = colorFrom[i]
					queue = append(queue, j)
				}
			}
		}
	}
	for i := 0; i < w*h; i++ {
		p := img.Pix[i*4 : i*4+4]
		switch {
		case solid[i]:
			p[3] = 255
		case (core[i] || outDist[i] <= 2) && colorFrom[i] >= 0:
			s := img.Pix[colorFrom[i]*4 : colorFrom[i]*4+3]
			p[0], p[1], p[2] = s[0], s[1], s[2]
			p[3] = uint8(math.Min(255, math.Round(float64(p[3])*255/250)))
		default:
			p[0], p[1], p[2], p[3] = 0, 0, 0, 0
		}
	}
}

// bfsDist returns, for every pixel where `want` holds, the 8-neighbour distance to the nearest pixel
// where `from` holds (-1 elsewhere, or if there is no such pixel).
func bfsDist(w, h int, from, want func(i int) bool) []int {
	dist := make([]int, w*h)
	var queue []int
	for i := range dist {
		dist[i] = -1
		if from(i) {
			dist[i] = 0
			queue = append(queue, i)
		}
	}
	for head := 0; head < len(queue); head++ {
		i := queue[head]
		x, y := i%w, i/w
		for dy := -1; dy <= 1; dy++ {
			for dx := -1; dx <= 1; dx++ {
				nx, ny := x+dx, y+dy
				if nx < 0 || ny < 0 || nx >= w || ny >= h {
					continue
				}
				j := ny*w + nx
				if dist[j] == -1 {
					dist[j] = dist[i] + 1
					queue = append(queue, j)
				}
			}
		}
	}
	for i := range dist {
		if !want(i) {
			dist[i] = -1
		}
	}
	return dist
}

// --- resampling -------------------------------------------------------------------------------

// pimg is a premultiplied-alpha float image, 4 values (R, G, B, A) per pixel in 0..255. Filtering in
// premultiplied form keeps the transparent corners from bleeding their (black) color into the rim.
type pimg struct {
	w, h int
	p    []float64
}

func fromNRGBA(n *image.NRGBA) *pimg {
	b := n.Bounds()
	m := &pimg{b.Dx(), b.Dy(), make([]float64, b.Dx()*b.Dy()*4)}
	for i := 0; i < m.w*m.h; i++ {
		s := n.Pix[i*4 : i*4+4]
		a := float64(s[3])
		m.p[i*4+0] = float64(s[0]) * a / 255
		m.p[i*4+1] = float64(s[1]) * a / 255
		m.p[i*4+2] = float64(s[2]) * a / 255
		m.p[i*4+3] = a
	}
	return m
}

func (m *pimg) toNRGBA() *image.NRGBA {
	n := image.NewNRGBA(image.Rect(0, 0, m.w, m.h))
	for i := 0; i < m.w*m.h; i++ {
		a := math.Max(0, math.Min(255, m.p[i*4+3]))
		if a == 0 {
			continue
		}
		for c := 0; c < 3; c++ {
			v := math.Max(0, math.Min(a, m.p[i*4+c])) * 255 / a
			n.Pix[i*4+c] = uint8(math.Round(v))
		}
		n.Pix[i*4+3] = uint8(math.Round(a))
	}
	return n
}

func lanczos3(x float64) float64 {
	x = math.Abs(x)
	if x >= 3 {
		return 0
	}
	if x < 1e-9 {
		return 1
	}
	px := math.Pi * x
	return 3 * math.Sin(px) * math.Sin(px/3) / (px * px)
}

func resample(src *pimg, dw, dh int) *pimg {
	return resampleAxis(resampleAxis(src, dw, true), dh, false)
}

// resampleAxis rescales one axis to n pixels with a Lanczos-3 filter widened by the scale factor (so
// downscaling averages over the whole source footprint instead of skipping pixels).
func resampleAxis(src *pimg, n int, horiz bool) *pimg {
	srcLen, otherLen := src.h, src.w
	if horiz {
		srcLen, otherLen = src.w, src.h
	}
	scale := float64(srcLen) / float64(n)
	filterScale := math.Max(scale, 1)
	support := 3 * filterScale

	var dst *pimg
	if horiz {
		dst = &pimg{n, src.h, make([]float64, n*src.h*4)}
	} else {
		dst = &pimg{src.w, n, make([]float64, src.w*n*4)}
	}
	index := func(m *pimg, along, other int) int { // pixel offset for (position on the axis, other coordinate)
		if horiz {
			return (other*m.w + along) * 4
		}
		return (along*m.w + other) * 4
	}

	weights := make([]float64, int(2*support)+4)
	for i := 0; i < n; i++ {
		center := (float64(i)+0.5)*scale - 0.5
		lo, hi := int(math.Ceil(center-support)), int(math.Floor(center+support))
		var sum float64
		for j := lo; j <= hi; j++ {
			w := lanczos3((float64(j) - center) / filterScale)
			weights[j-lo] = w
			sum += w
		}
		for o := 0; o < otherLen; o++ {
			var acc [4]float64
			for j := lo; j <= hi; j++ {
				k := min(max(j, 0), srcLen-1) // clamp: edge pixels extend outward
				w := weights[j-lo] / sum
				s := index(src, k, o)
				acc[0] += w * src.p[s]
				acc[1] += w * src.p[s+1]
				acc[2] += w * src.p[s+2]
				acc[3] += w * src.p[s+3]
			}
			d := index(dst, i, o)
			copy(dst.p[d:d+4], acc[:])
		}
	}
	return dst
}

// sharpen is an unsharp mask on the color channels (alpha is left alone): out = s + amount*(s - blur).
// The color stays within [0, alpha], so it cannot become invalid.
func sharpen(src *pimg, sigma, amount float64) *pimg {
	blur := gaussBlur(src, sigma)
	out := &pimg{src.w, src.h, make([]float64, len(src.p))}
	copy(out.p, src.p)
	for i := 0; i < src.w*src.h; i++ {
		a := src.p[i*4+3]
		for c := 0; c < 3; c++ {
			v := src.p[i*4+c] + amount*(src.p[i*4+c]-blur.p[i*4+c])
			out.p[i*4+c] = math.Max(0, math.Min(a, v))
		}
	}
	return out
}

func gaussBlur(src *pimg, sigma float64) *pimg {
	radius := int(math.Ceil(sigma * 3))
	kernel := make([]float64, 2*radius+1)
	var sum float64
	for i := range kernel {
		d := float64(i - radius)
		kernel[i] = math.Exp(-d * d / (2 * sigma * sigma))
		sum += kernel[i]
	}
	for i := range kernel {
		kernel[i] /= sum
	}
	pass := func(in *pimg, horiz bool) *pimg {
		out := &pimg{in.w, in.h, make([]float64, len(in.p))}
		for y := 0; y < in.h; y++ {
			for x := 0; x < in.w; x++ {
				var acc [4]float64
				for k, kw := range kernel {
					sx, sy := x, y
					if horiz {
						sx = min(max(x+k-radius, 0), in.w-1)
					} else {
						sy = min(max(y+k-radius, 0), in.h-1)
					}
					s := (sy*in.w + sx) * 4
					for c := 0; c < 4; c++ {
						acc[c] += kw * in.p[s+c]
					}
				}
				copy(out.p[(y*in.w+x)*4:], acc[:])
			}
		}
		return out
	}
	return pass(pass(src, true), false)
}

// --- files and the contact sheet --------------------------------------------------------------

func loadNRGBA(path string) (*image.NRGBA, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	n := image.NewNRGBA(img.Bounds())
	draw.Draw(n, n.Bounds(), img, img.Bounds().Min, draw.Src)
	return n, nil
}

func writePNG(path string, img image.Image) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(f, img); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// contactSheet lays out 16/24/32/48 px: top row magnified (nearest neighbor, ~192 px) on a checker,
// then actual size on a light and on a dark background, like a taskbar or an Explorer window.
func contactSheet(icons map[int]*image.NRGBA) *image.NRGBA {
	sizes := []int{16, 24, 32, 48}
	const cell, pad = 192, 16
	W := len(sizes)*(cell+pad) + pad
	H := pad + cell + pad + 64 + pad + 64 + pad
	sheet := image.NewNRGBA(image.Rect(0, 0, W, H))
	fill := func(r image.Rectangle, c color.NRGBA) {
		draw.Draw(sheet, r, image.NewUniform(c), image.Point{}, draw.Src)
	}
	fill(sheet.Bounds(), color.NRGBA{0x80, 0x80, 0x80, 255})
	for i, s := range sizes {
		x0 := pad + i*(cell+pad)
		// magnified, over a checkerboard so the transparency is visible
		mag := cell / s
		for y := 0; y < cell; y += 8 {
			for x := 0; x < cell; x += 8 {
				c := color.NRGBA{0xcc, 0xcc, 0xcc, 255}
				if (x/8+y/8)%2 == 1 {
					c = color.NRGBA{0xee, 0xee, 0xee, 255}
				}
				fill(image.Rect(x0+x, pad+y, x0+x+8, pad+y+8), c)
			}
		}
		ic := icons[s]
		for y := 0; y < s; y++ {
			for x := 0; x < s; x++ {
				c := ic.NRGBAAt(x, y)
				r := image.Rect(x0+x*mag, pad+y*mag, x0+(x+1)*mag, pad+(y+1)*mag)
				draw.Draw(sheet, r, image.NewUniform(c), image.Point{}, draw.Over)
			}
		}
		// actual size on light and dark
		for row, bg := range []color.NRGBA{{0xf3, 0xf3, 0xf3, 255}, {0x20, 0x20, 0x20, 255}} {
			y0 := pad + cell + pad + row*(64+pad)
			fill(image.Rect(x0, y0, x0+cell, y0+64), bg)
			ox, oy := x0+(cell-s)/2, y0+(64-s)/2
			draw.Draw(sheet, image.Rect(ox, oy, ox+s, oy+s), ic, image.Point{}, draw.Over)
		}
	}
	return sheet
}
