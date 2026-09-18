package feedback

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
	"unicode/utf8"
)

type ReadInput struct {
	ArtifactID string `json:"artifact_id"`
	Cursor     string `json:"cursor"`
	Limit      int    `json:"limit"`
	Keyword    string `json:"keyword"`
	Level      string `json:"level"`
	RunID      string `json:"run_id"`
	From       string `json:"from"`
	To         string `json:"to"`
}
type readCursor struct {
	Binding  string `json:"binding"`
	Part     int    `json:"part"`
	Offset   int64  `json:"offset"`
	Fragment int    `json:"fragment"`
}

func (s *Service) Read(ctx context.Context, a Actor, id, kind string, in ReadInput) (out map[string]any, err error) {
	defer func() { observeOperation("read", err) }()
	if e := s.check(ctx, a, "read"); e != nil {
		return nil, e
	}
	var r Report
	err = s.store.View(ctx, func(tx ReadTransaction) error {
		var e error
		r, e = tx.Get(id)
		if e != nil {
			return e
		}
		return readable(r, s.clock())
	})
	if err != nil {
		return nil, err
	}
	if in.Limit < 1 {
		in.Limit = 100
	}
	if in.Limit > 500 {
		in.Limit = 500
	}
	if len(in.Keyword) > 256 {
		return nil, fail(400, "feedback_invalid_filter")
	}
	arts := []StoredArtifact{}
	for _, art := range r.Artifacts {
		if (kind == "conversation" && art.Kind == kind) || (kind == "logs" && art.ID == in.ArtifactID && (art.Kind == "logs" || art.Kind == "diagnostics")) {
			arts = append(arts, art)
		}
	}
	if len(arts) == 0 {
		return nil, ErrNotFound
	}
	criteria := in
	criteria.Cursor = ""
	criteria.Limit = 0
	b, _ := json.Marshal(criteria)
	c := readCursor{Binding: Hash([]byte(id + "|" + kind + "|" + r.ManifestHash + "|" + string(b)))}
	if in.Cursor != "" {
		raw, e := base64.RawURLEncoding.DecodeString(in.Cursor)
		var supplied readCursor
		if e != nil || json.Unmarshal(raw, &supplied) != nil || supplied.Binding != c.Binding || supplied.Part < 0 || supplied.Part >= len(arts) || supplied.Offset < 0 || supplied.Offset > arts[supplied.Part].Size || supplied.Fragment < 0 || supplied.Fragment > int(MaxArtifactBytes) {
			return nil, fail(400, "feedback_invalid_cursor")
		}
		c = supplied
	}
	records := []any{}
	scanned := 0
	bytes := 0
	for c.Part < len(arts) && len(records) < in.Limit && scanned < 500 && bytes < 128<<10 {
		art := arts[c.Part]
		f, _, e := s.Open(ctx, a, id, art.ID, false)
		if e != nil {
			return nil, e
		}
		if _, e = io.CopyN(io.Discard, f, c.Offset); e != nil {
			_ = f.Close()
			return nil, fail(400, "feedback_invalid_cursor")
		}
		reader := bufio.NewReader(f)
		for len(records) < in.Limit && scanned < 500 && bytes < 128<<10 {
			line, e := reader.ReadString('\n')
			if e != nil && e != io.EOF {
				_ = f.Close()
				return nil, fail(503, "feedback_read_failed")
			}
			if len(line) == 0 {
				c.Part++
				c.Offset = 0
				c.Fragment = 0
				break
			}
			scanned++
			text := strings.TrimSuffix(line, "\n")
			if c.Fragment > len(text) {
				_ = f.Close()
				return nil, fail(400, "feedback_invalid_cursor")
			}
			match := in.Keyword == "" || strings.Contains(text, in.Keyword)
			if in.Level != "" || in.RunID != "" || in.From != "" || in.To != "" {
				var fields map[string]any
				_ = json.Unmarshal([]byte(text), &fields)
				if nested, ok := fields["record"].(map[string]any); ok {
					for _, key := range []string{"level", "timestamp", "created_at"} {
						if _, exists := fields[key]; !exists {
							fields[key] = nested[key]
						}
					}
					if fields["timestamp"] == nil {
						fields["timestamp"] = nested["at"]
					}
				}
				if in.Level != "" && fields["level"] != in.Level {
					match = false
				}
				if in.RunID != "" && fields["run_id"] != in.RunID {
					match = false
				}
				timestamp, _ := fields["timestamp"].(string)
				if timestamp == "" {
					timestamp, _ = fields["created_at"].(string)
				}
				if in.From != "" && timestamp < in.From || in.To != "" && timestamp > in.To {
					match = false
				}
			}
			if match {
				remaining := text[c.Fragment:]
				take := len(remaining)
				if take > 16<<10 {
					take = 16 << 10
					for take > 0 && !utf8.ValidString(remaining[:take]) {
						take--
					}
				}
				piece := remaining[:take]
				entry := map[string]any{"artifact_id": art.ID, "source": art.Source, "offset": c.Offset, "fragment_offset": c.Fragment, "text": piece, "continuation": c.Fragment+take < len(text)}
				encoded, _ := json.Marshal(entry)
				bytes += len(encoded)
				records = append(records, entry)
				if c.Fragment+take < len(text) {
					c.Fragment += take
					break
				}
			}
			c.Offset += int64(len(line))
			c.Fragment = 0
		}
		_ = f.Close()
		// 分段记录保持同一源位置，下一页从该记录继续。
		if c.Fragment > 0 {
			break
		}
	}
	next := ""
	if c.Part < len(arts) {
		raw, _ := json.Marshal(c)
		next = base64.RawURLEncoding.EncodeToString(raw)
	}
	var manifest Manifest
	_ = json.Unmarshal(r.Manifest, &manifest)
	return map[string]any{"report_id": id, "records": records, "next_cursor": next, "has_next": next != "", "scanned_records": scanned, "snapshot_at": manifest.SnapshotAt}, nil
}
