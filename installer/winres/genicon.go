// SPDX-License-Identifier: GPL-3.0-or-later

//go:build ignore

// genicon draws the installer icon (a little screen: "telinha") at every icon size, so each PNG is
// rendered crisp instead of downscaled. Run from installer/: go run winres/genicon.go
package main

import (
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strconv"
)

const ss = 4 // supersampling per axis

type shape func(x, y float64) bool // coordinates in a 0..1 square

func roundRect(x0, y0, x1, y1, r float64) shape {
	return func(x, y float64) bool {
		if x < x0 || x > x1 || y < y0 || y > y1 {
			return false
		}
		cx := math.Max(x0+r, math.Min(x, x1-r))
		cy := math.Max(y0+r, math.Min(y, y1-r))
		return (x-cx)*(x-cx)+(y-cy)*(y-cy) <= r*r
	}
}

func triangle(ax, ay, bx, by, cx, cy float64) shape {
	sign := func(px, py, qx, qy, rx, ry float64) float64 { return (px-rx)*(qy-ry) - (qx-rx)*(py-ry) }
	return func(x, y float64) bool {
		d1, d2, d3 := sign(x, y, ax, ay, bx, by), sign(x, y, bx, by, cx, cy), sign(x, y, cx, cy, ax, ay)
		neg := d1 < 0 || d2 < 0 || d3 < 0
		pos := d1 > 0 || d2 > 0 || d3 > 0
		return !(neg && pos)
	}
}

type layer struct {
	s shape
	c func(x, y float64) color.NRGBA
}

func solid(c color.NRGBA) func(x, y float64) color.NRGBA {
	return func(_, _ float64) color.NRGBA { return c }
}

func render(size int) *image.NRGBA {
	top, bottom := color.NRGBA{0x6D, 0x78, 0xF7, 255}, color.NRGBA{0x45, 0x4F, 0xC4, 255}
	bg := func(_, y float64) color.NRGBA {
		lerp := func(a, b uint8) uint8 { return uint8(float64(a) + (float64(b)-float64(a))*y) }
		return color.NRGBA{lerp(top.R, bottom.R), lerp(top.G, bottom.G), lerp(top.B, bottom.B), 255}
	}
	white := color.NRGBA{255, 255, 255, 255}
	screen := color.NRGBA{0x23, 0x27, 0x5E, 255}
	accent := color.NRGBA{0x57, 0xF2, 0x87, 255}

	layers := []layer{
		{roundRect(0.03, 0.03, 0.97, 0.97, 0.22), bg},
		{roundRect(0.17, 0.22, 0.83, 0.67, 0.07), solid(white)},   // monitor bezel
		{roundRect(0.22, 0.27, 0.78, 0.62, 0.035), solid(screen)}, // screen
		{triangle(0.44, 0.35, 0.44, 0.54, 0.60, 0.445), solid(accent)},
		{roundRect(0.45, 0.66, 0.55, 0.75, 0.0), solid(white)}, // stand
		{roundRect(0.33, 0.74, 0.67, 0.80, 0.03), solid(white)},
	}
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			var r, g, b, a float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					x := (float64(px) + (float64(sx)+0.5)/ss) / float64(size)
					y := (float64(py) + (float64(sy)+0.5)/ss) / float64(size)
					var c color.NRGBA
					for _, l := range layers {
						if l.s(x, y) {
							c = l.c(x, y)
						}
					}
					fa := float64(c.A) / 255
					r, g, b, a = r+float64(c.R)*fa, g+float64(c.G)*fa, b+float64(c.B)*fa, a+fa
				}
			}
			n := float64(ss * ss)
			if a > 0 {
				img.SetNRGBA(px, py, color.NRGBA{uint8(r / a), uint8(g / a), uint8(b / a), uint8(255 * a / n)})
			}
		}
	}
	return img
}

func main() {
	for _, s := range []int{256, 64, 48, 32, 24, 16} {
		f, err := os.Create(filepath.Join("winres", "icon"+strconv.Itoa(s)+".png"))
		if err != nil {
			panic(err)
		}
		if err := png.Encode(f, render(s)); err != nil {
			panic(err)
		}
		f.Close()
	}
}
