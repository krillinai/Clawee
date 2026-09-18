package accounts

import (
	"crypto/sha256"
	"encoding/hex"
	"html"
	"strings"
)

// GeneratedAvatar 生成稳定的 SVG 头像，与上传头像一样保存在账户记录中。
func GeneratedAvatar(account Account) AccountAvatar {
	label := account.DisplayName()
	runes := []rune(strings.TrimSpace(label))
	if len(runes) == 0 {
		label = "?"
	} else {
		label = string(runes[:1])
	}

	digest := sha256.Sum256([]byte(account.UserID + "\x00" + account.Email))
	background := "#" + hex.EncodeToString(digest[:3])
	foreground := "#ffffff"
	if luminance(digest[0], digest[1], digest[2]) > 0.62 {
		foreground = "#1f2937"
	}
	svg := "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"96\" height=\"96\" viewBox=\"0 0 96 96\"><rect width=\"96\" height=\"96\" rx=\"48\" fill=\"" + background + "\"/><text x=\"48\" y=\"52\" text-anchor=\"middle\" dominant-baseline=\"middle\" fill=\"" + foreground + "\" font-family=\"Arial, sans-serif\" font-size=\"42\">" + html.EscapeString(label) + "</text></svg>"
	return AccountAvatar{Data: []byte(svg), ContentType: "image/svg+xml", Source: AvatarSourceGenerated}
}

func luminance(red, green, blue byte) float64 {
	return (0.299*float64(red) + 0.587*float64(green) + 0.114*float64(blue)) / 255
}
