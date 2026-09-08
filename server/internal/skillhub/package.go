package skillhub

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

var (
	skillNamePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`)
	windowsDrivePath = regexp.MustCompile(`^[A-Za-z]:`)
)

func ValidatePackage(reader io.ReaderAt, size int64) (PackageMetadata, error) {
	return NormalizePackage(reader, size, io.Discard)
}

func NormalizePackage(reader io.ReaderAt, size int64, output io.Writer) (PackageMetadata, error) {
	if reader == nil || size <= 0 {
		return PackageMetadata{}, packageInvalid("上传文件为空")
	}
	if output == nil {
		return PackageMetadata{}, errors.New("规范 ZIP 输出不能为空")
	}
	if size > MaxPackageSize {
		return PackageMetadata{}, ErrPackageTooLarge
	}
	archive, err := zip.NewReader(reader, size)
	if err != nil {
		return PackageMetadata{}, packageInvalid("文件不是有效的 ZIP 压缩包")
	}
	if len(archive.File) == 0 {
		return PackageMetadata{}, packageInvalid("ZIP 压缩包为空")
	}
	if len(archive.File) > MaxPackageEntries {
		return PackageMetadata{}, packageInvalidf("ZIP 文件条目不能超过 %d 个", MaxPackageEntries)
	}

	type packageEntry struct {
		name           string
		directory      bool
		systemMetadata bool
	}
	seen := make(map[string]struct{}, len(archive.File))
	entries := make([]packageEntry, len(archive.File))
	contentEntryNames := make([]string, 0, len(archive.File))
	for i, file := range archive.File {
		name, err := validateEntryName(file.Name)
		if err != nil {
			return PackageMetadata{}, err
		}
		if _, exists := seen[name]; exists {
			return PackageMetadata{}, packageInvalidf("ZIP 中存在重复路径 %q", name)
		}
		seen[name] = struct{}{}
		mode := file.Mode()
		directory := file.FileInfo().IsDir()
		if directory {
			if mode&^(mode.Perm()|mode.Type()) != 0 {
				return PackageMetadata{}, packageInvalidf("目录条目 %q 的类型或权限不合法", name)
			}
		} else if !mode.IsRegular() {
			return PackageMetadata{}, packageInvalidf("文件 %q 不支持符号链接或其他特殊文件", name)
		}
		systemMetadata := isSystemMetadataEntry(name, directory)
		entries[i] = packageEntry{name: name, directory: directory, systemMetadata: systemMetadata}
		if !systemMetadata {
			contentEntryNames = append(contentEntryNames, name)
		}
	}
	skillMDPath, err := locateSkillMD(contentEntryNames)
	if err != nil {
		return PackageMetadata{}, err
	}

	normalized := zip.NewWriter(output)
	normalizedClosed := false
	defer func() {
		if !normalizedClosed {
			_ = normalized.Close()
		}
	}()

	var skillMD []byte
	var total int64
	for i, file := range archive.File {
		entryInfo := entries[i]
		name := entryInfo.name
		mode := file.Mode()
		if entryInfo.directory {
			if entryInfo.systemMetadata {
				continue
			}
			header := &zip.FileHeader{Name: name + "/", Method: zip.Store}
			header.SetMode(mode)
			if _, err := normalized.CreateHeader(header); err != nil {
				return PackageMetadata{}, fmt.Errorf("写入规范 ZIP 目录 %q: %w", name, err)
			}
			continue
		}
		entry, err := file.Open()
		if err != nil {
			return PackageMetadata{}, packageInvalidf("无法读取 ZIP 中的文件 %q", name)
		}
		remaining := MaxUncompressedSize - total
		var target io.Writer = io.Discard
		if !entryInfo.systemMetadata {
			header := &zip.FileHeader{Name: name, Method: zip.Deflate}
			header.SetMode(mode)
			target, err = normalized.CreateHeader(header)
			if err != nil {
				_ = entry.Close()
				return PackageMetadata{}, fmt.Errorf("写入规范 ZIP 文件 %q: %w", name, err)
			}
		}
		var capture limitedCaptureWriter
		if name == skillMDPath {
			capture.limit = MaxSkillMDSize
			target = io.MultiWriter(target, &capture)
		}
		written, copyErr := io.Copy(target, io.LimitReader(entry, remaining+1))
		closeErr := entry.Close()
		if copyErr != nil || closeErr != nil {
			return PackageMetadata{}, packageInvalidf("无法读取 ZIP 中的文件 %q", name)
		}
		total += written
		if total > MaxUncompressedSize {
			return PackageMetadata{}, ErrPackageTooLarge
		}
		if name == skillMDPath {
			if capture.overflow {
				return PackageMetadata{}, packageInvalidf("SKILL.md 不能超过 %d 字节", MaxSkillMDSize)
			}
			skillMD = capture.data
		}
	}
	if skillMD == nil {
		return PackageMetadata{}, packageInvalid("SKILL.md 必须是普通文件")
	}
	metadata, err := parseSkillMD(skillMD)
	if err != nil {
		return PackageMetadata{}, err
	}
	if err := normalized.Close(); err != nil {
		normalizedClosed = true
		return PackageMetadata{}, fmt.Errorf("关闭规范 ZIP: %w", err)
	}
	normalizedClosed = true
	return metadata, nil
}

func isSystemMetadataEntry(name string, directory bool) bool {
	segments := strings.Split(name, "/")
	if segments[0] == "__MACOSX" {
		return true
	}
	for _, segment := range segments {
		if strings.HasPrefix(segment, "._") {
			return true
		}
	}
	return !directory && path.Base(name) == ".DS_Store"
}

func locateSkillMD(entryNames []string) (string, error) {
	for _, name := range entryNames {
		if name == "SKILL.md" {
			return name, nil
		}
	}

	var skillMDPath string
	var wrapper string
	nestedSkillMD := false
	for _, name := range entryNames {
		if path.Base(name) != "SKILL.md" {
			continue
		}
		directory := path.Dir(name)
		if strings.Contains(directory, "/") {
			nestedSkillMD = true
			continue
		}
		if skillMDPath != "" && skillMDPath != name {
			return "", packageInvalid("ZIP 只能包含一个带 SKILL.md 的顶层包装目录")
		}
		skillMDPath = name
		wrapper = directory
	}
	if skillMDPath == "" {
		if nestedSkillMD {
			return "", packageInvalid("ZIP 仅支持一层顶层包装目录，且 SKILL.md 必须直接位于该目录下")
		}
		return "", packageInvalid("ZIP 根目录或单一顶层包装目录下缺少 SKILL.md")
	}
	for _, name := range entryNames {
		if name == wrapper || strings.HasPrefix(name, wrapper+"/") {
			continue
		}
		return "", packageInvalidf("使用顶层包装目录 %q 时，ZIP 中不能包含该目录之外的条目 %q", wrapper, name)
	}
	return skillMDPath, nil
}

type limitedCaptureWriter struct {
	data     []byte
	limit    int64
	overflow bool
}

func (w *limitedCaptureWriter) Write(data []byte) (int, error) {
	remaining := w.limit - int64(len(w.data))
	if remaining > 0 {
		keep := int64(len(data))
		if keep > remaining {
			keep = remaining
		}
		w.data = append(w.data, data[:keep]...)
	}
	if int64(len(data)) > remaining {
		w.overflow = true
	}
	return len(data), nil
}

func validateEntryName(raw string) (string, error) {
	if raw == "" {
		return "", packageInvalid("ZIP 中存在空文件路径")
	}
	if strings.Contains(raw, `\`) {
		return "", packageInvalidf("文件路径 %q 不合法，路径必须使用正斜杠", raw)
	}
	if strings.HasPrefix(raw, "/") {
		return "", packageInvalidf("文件路径 %q 包含绝对路径", raw)
	}
	if windowsDrivePath.MatchString(raw) {
		return "", packageInvalidf("文件路径 %q 包含 Windows 盘符路径", raw)
	}
	for _, segment := range strings.Split(raw, "/") {
		if segment == ".." {
			return "", packageInvalidf("文件路径 %q 包含不安全的上级目录路径", raw)
		}
	}
	cleaned := path.Clean(raw)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", packageInvalidf("文件路径 %q 不合法", raw)
	}
	return strings.TrimSuffix(cleaned, "/"), nil
}

func parseSkillMD(data []byte) (PackageMetadata, error) {
	if !utf8.Valid(data) {
		return PackageMetadata{}, packageInvalid("SKILL.md 必须使用 UTF-8 编码")
	}
	lines := strings.Split(string(data), "\n")
	if len(lines) < 3 || strings.TrimSuffix(lines[0], "\r") != "---" {
		return PackageMetadata{}, packageInvalid("SKILL.md 必须以 frontmatter 起始标记 --- 开头")
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSuffix(lines[i], "\r") == "---" {
			end = i
			break
		}
	}
	if end < 0 {
		return PackageMetadata{}, packageInvalid("SKILL.md 缺少 frontmatter 结束标记 ---")
	}
	frontmatter := strings.Join(lines[1:end], "\n")
	var document yaml.Node
	decoder := yaml.NewDecoder(strings.NewReader(frontmatter))
	if err := decoder.Decode(&document); err != nil {
		return PackageMetadata{}, packageInvalidf("SKILL.md frontmatter YAML 解析失败：%v", err)
	}
	if len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return PackageMetadata{}, packageInvalid("SKILL.md frontmatter 必须是键值映射")
	}
	mapping := document.Content[0]
	if err := validateUniqueMappingKeys(mapping); err != nil {
		return PackageMetadata{}, err
	}
	values := make(map[string]*yaml.Node, len(mapping.Content)/2)
	for i := 0; i < len(mapping.Content); i += 2 {
		key := mapping.Content[i]
		value := mapping.Content[i+1]
		if key.Kind != yaml.ScalarNode || key.Tag != "!!str" {
			return PackageMetadata{}, packageInvalid("SKILL.md frontmatter 字段名必须是字符串")
		}
		if _, exists := values[key.Value]; exists {
			return PackageMetadata{}, packageInvalidf("SKILL.md frontmatter 存在重复字段 %s", key.Value)
		}
		values[key.Value] = value
	}
	nameNode := values["name"]
	if nameNode == nil {
		return PackageMetadata{}, packageInvalid("SKILL.md frontmatter 缺少必填字段 name")
	}
	if nameNode.Kind != yaml.ScalarNode || nameNode.Tag != "!!str" {
		return PackageMetadata{}, packageInvalid("SKILL.md frontmatter 的 name 必须是字符串")
	}
	name := nameNode.Value
	if !skillNamePattern.MatchString(name) || len(name) > 64 {
		return PackageMetadata{}, packageInvalid("SKILL.md frontmatter 的 name 仅允许小写字母、数字和连字符，长度不能超过 64 个字符")
	}
	descriptionNode := values["description"]
	if descriptionNode == nil {
		return PackageMetadata{}, packageInvalid("SKILL.md frontmatter 缺少必填字段 description")
	}
	if descriptionNode.Kind != yaml.ScalarNode || descriptionNode.Tag != "!!str" {
		return PackageMetadata{}, packageInvalid("SKILL.md frontmatter 的 description 必须是字符串")
	}
	description := descriptionNode.Value
	description = strings.TrimSpace(description)
	if description == "" {
		return PackageMetadata{}, packageInvalid("SKILL.md frontmatter 的 description 不能为空")
	}
	if len([]rune(description)) > MaxDescriptionRunes {
		return PackageMetadata{}, packageInvalidf("SKILL.md frontmatter 的 description 不能超过 %d 个字符", MaxDescriptionRunes)
	}
	return PackageMetadata{Name: name, Description: description}, nil
}

func validateUniqueMappingKeys(node *yaml.Node) error {
	switch node.Kind {
	case yaml.MappingNode:
		seen := make(map[string]struct{}, len(node.Content)/2)
		for i := 0; i < len(node.Content); i += 2 {
			key := node.Content[i]
			if key.Kind != yaml.ScalarNode || key.Tag != "!!str" {
				return packageInvalid("SKILL.md frontmatter 字段名必须是字符串")
			}
			if _, exists := seen[key.Value]; exists {
				return packageInvalidf("SKILL.md frontmatter 存在重复字段 %s", key.Value)
			}
			seen[key.Value] = struct{}{}
			if err := validateUniqueMappingKeys(node.Content[i+1]); err != nil {
				return err
			}
		}
	case yaml.SequenceNode:
		for _, child := range node.Content {
			if err := validateUniqueMappingKeys(child); err != nil {
				return err
			}
		}
	}
	return nil
}

type packageValidationError struct {
	reason string
}

func (e *packageValidationError) Error() string {
	return ErrPackageInvalid.Error() + ": " + e.reason
}

func (e *packageValidationError) Unwrap() error {
	return ErrPackageInvalid
}

func packageInvalid(reason string) error {
	return &packageValidationError{reason: reason}
}

func packageInvalidf(format string, args ...any) error {
	return packageInvalid(fmt.Sprintf(format, args...))
}

func PackageInvalidReason(err error) string {
	var validationErr *packageValidationError
	if errors.As(err, &validationErr) {
		return validationErr.reason
	}
	return ""
}
