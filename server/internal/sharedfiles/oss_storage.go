package sharedfiles

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
	"go.uber.org/zap"
)

const ossMultipartPartSize int64 = 16 << 20

var officialOSSEndpointPatterns = []*regexp.Regexp{
	regexp.MustCompile("^oss-[a-z0-9-]+(?:-internal)?\\.aliyuncs\\.com$"),
	regexp.MustCompile("^[a-z0-9-]+\\.oss(?:-internal)?\\.aliyuncs\\.com$"),
}

var (
	ossBucketPattern = regexp.MustCompile("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
	ossRegionPattern = regexp.MustCompile("^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$")
)

type credentialCipher interface {
	Encrypt([]byte) ([]byte, error)
	Decrypt([]byte) ([]byte, error)
}

type ossClient interface {
	PutObject(context.Context, *oss.PutObjectRequest, ...func(*oss.Options)) (*oss.PutObjectResult, error)
	GetObject(context.Context, *oss.GetObjectRequest, ...func(*oss.Options)) (*oss.GetObjectResult, error)
	DeleteObject(context.Context, *oss.DeleteObjectRequest, ...func(*oss.Options)) (*oss.DeleteObjectResult, error)
	InitiateMultipartUpload(context.Context, *oss.InitiateMultipartUploadRequest, ...func(*oss.Options)) (*oss.InitiateMultipartUploadResult, error)
	UploadPart(context.Context, *oss.UploadPartRequest, ...func(*oss.Options)) (*oss.UploadPartResult, error)
	CompleteMultipartUpload(context.Context, *oss.CompleteMultipartUploadRequest, ...func(*oss.Options)) (*oss.CompleteMultipartUploadResult, error)
	AbortMultipartUpload(context.Context, *oss.AbortMultipartUploadRequest, ...func(*oss.Options)) (*oss.AbortMultipartUploadResult, error)
}

type AliyunOSSStorage struct {
	client   ossClient
	bucket   string
	prefix   string
	partSize int64
}

func NewAliyunOSSStorage(client ossClient, bucket, prefix string) (*AliyunOSSStorage, error) {
	if client == nil || strings.TrimSpace(bucket) == "" {
		return nil, ErrInvalidStorageConfiguration
	}
	return &AliyunOSSStorage{client: client, bucket: strings.TrimSpace(bucket), prefix: normalizeObjectPrefix(prefix), partSize: ossMultipartPartSize}, nil
}

func (s *AliyunOSSStorage) Put(ctx context.Context, key string, src io.Reader, opts PutOptions) (ObjectMetadata, error) {
	if opts.DeclaredSize < 0 || opts.MaxBytes < 0 || opts.DeclaredSize > opts.MaxBytes {
		if opts.DeclaredSize > opts.MaxBytes {
			return ObjectMetadata{}, ErrFileTooLarge
		}
		return ObjectMetadata{}, ErrContentLengthMismatch
	}
	tmp, err := os.CreateTemp("", "clawee-oss-upload-*")
	if err != nil {
		return ObjectMetadata{}, ErrStorageUnavailable
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(tmp, hash), io.LimitReader(&contextReader{ctx: ctx, reader: src}, opts.MaxBytes+1))
	if closeErr := tmp.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return ObjectMetadata{}, mapOSSError(ctx, copyErr)
	}
	if size > opts.MaxBytes {
		return ObjectMetadata{}, ErrFileTooLarge
	}
	if size != opts.DeclaredSize {
		return ObjectMetadata{}, ErrContentLengthMismatch
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	if opts.SHA256 != "" && opts.SHA256 != digest {
		return ObjectMetadata{}, ErrDigestMismatch
	}
	opts.SHA256 = digest
	file, err := os.Open(tmpName)
	if err != nil {
		return ObjectMetadata{}, ErrStorageUnavailable
	}
	defer file.Close()
	if opts.DeclaredSize <= s.partSize {
		return s.putObject(ctx, key, file, opts)
	}
	return s.putMultipart(ctx, key, file, opts)
}

func (s *AliyunOSSStorage) putObject(ctx context.Context, key string, src io.Reader, opts PutOptions) (ObjectMetadata, error) {
	hash := sha256.New()
	reader := io.LimitReader(&contextReader{ctx: ctx, reader: src}, opts.MaxBytes+1)
	counting := &ossCountingReader{reader: io.TeeReader(reader, hash)}
	objectKey := s.objectKey(key)
	_, err := s.client.PutObject(ctx, &oss.PutObjectRequest{
		Bucket: oss.Ptr(s.bucket), Key: oss.Ptr(objectKey), Body: counting,
		ContentLength: oss.Ptr(opts.DeclaredSize), ContentType: oss.Ptr(opts.ContentType),
		Metadata: objectMetadataHeaders(opts),
	})
	if err != nil {
		return ObjectMetadata{}, mapOSSError(ctx, err)
	}
	if counting.count > opts.MaxBytes {
		_ = s.Delete(context.WithoutCancel(ctx), key)
		return ObjectMetadata{}, ErrFileTooLarge
	}
	if counting.count != opts.DeclaredSize {
		_ = s.Delete(context.WithoutCancel(ctx), key)
		return ObjectMetadata{}, ErrContentLengthMismatch
	}
	return ObjectMetadata{SizeBytes: counting.count, SHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

func (s *AliyunOSSStorage) putMultipart(ctx context.Context, key string, src io.Reader, opts PutOptions) (ObjectMetadata, error) {
	objectKey := s.objectKey(key)
	initResult, err := s.client.InitiateMultipartUpload(ctx, &oss.InitiateMultipartUploadRequest{
		Bucket: oss.Ptr(s.bucket), Key: oss.Ptr(objectKey), ContentType: oss.Ptr(opts.ContentType), Metadata: objectMetadataHeaders(opts),
	})
	if err != nil {
		return ObjectMetadata{}, mapOSSError(ctx, err)
	}
	uploadID := oss.ToString(initResult.UploadId)
	completed := false
	defer func() {
		if completed {
			return
		}
		_, _ = s.client.AbortMultipartUpload(context.WithoutCancel(ctx), &oss.AbortMultipartUploadRequest{
			Bucket: oss.Ptr(s.bucket), Key: oss.Ptr(objectKey), UploadId: oss.Ptr(uploadID),
		})
	}()

	hash := sha256.New()
	reader := &contextReader{ctx: ctx, reader: io.LimitReader(src, opts.MaxBytes+1)}
	parts := make([]oss.UploadPart, 0, (opts.DeclaredSize+s.partSize-1)/s.partSize)
	buffer := make([]byte, s.partSize)
	var total int64
	for partNumber := int32(1); ; partNumber++ {
		n, readErr := io.ReadFull(reader, buffer)
		if readErr != nil && !errors.Is(readErr, io.ErrUnexpectedEOF) && !errors.Is(readErr, io.EOF) {
			return ObjectMetadata{}, mapOSSError(ctx, readErr)
		}
		if n == 0 {
			break
		}
		total += int64(n)
		if total > opts.MaxBytes {
			return ObjectMetadata{}, ErrFileTooLarge
		}
		_, _ = hash.Write(buffer[:n])
		partResult, uploadErr := s.client.UploadPart(ctx, &oss.UploadPartRequest{
			Bucket: oss.Ptr(s.bucket), Key: oss.Ptr(objectKey), UploadId: oss.Ptr(uploadID), PartNumber: partNumber,
			Body: bytes.NewReader(buffer[:n]), ContentLength: oss.Ptr(int64(n)),
		})
		if uploadErr != nil {
			return ObjectMetadata{}, mapOSSError(ctx, uploadErr)
		}
		parts = append(parts, oss.UploadPart{PartNumber: partNumber, ETag: partResult.ETag})
		if errors.Is(readErr, io.ErrUnexpectedEOF) || errors.Is(readErr, io.EOF) {
			break
		}
	}
	if total != opts.DeclaredSize {
		return ObjectMetadata{}, ErrContentLengthMismatch
	}
	_, err = s.client.CompleteMultipartUpload(ctx, &oss.CompleteMultipartUploadRequest{
		Bucket: oss.Ptr(s.bucket), Key: oss.Ptr(objectKey), UploadId: oss.Ptr(uploadID),
		CompleteMultipartUpload: &oss.CompleteMultipartUpload{Parts: parts},
	})
	if err != nil {
		return ObjectMetadata{}, mapOSSError(ctx, err)
	}
	completed = true
	return ObjectMetadata{SizeBytes: total, SHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

func (s *AliyunOSSStorage) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	result, err := s.client.GetObject(ctx, &oss.GetObjectRequest{Bucket: oss.Ptr(s.bucket), Key: oss.Ptr(s.objectKey(key))})
	if err != nil {
		return nil, mapOSSError(ctx, err)
	}
	return result.Body, nil
}

func (s *AliyunOSSStorage) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &oss.DeleteObjectRequest{Bucket: oss.Ptr(s.bucket), Key: oss.Ptr(s.objectKey(key))})
	return mapOSSError(ctx, err)
}

func (s *AliyunOSSStorage) Probe(ctx context.Context) error {
	key := "_probe/" + newID("probe_")
	content := []byte(newID("clawee_probe_"))
	metadata, err := s.Put(ctx, key, bytes.NewReader(content), PutOptions{
		DeclaredSize: int64(len(content)), MaxBytes: int64(len(content)), ContentType: "application/octet-stream",
		FileID: "probe", ProfileID: "probe",
	})
	if err != nil {
		return ErrStorageProbeFailed
	}
	reader, err := s.Open(ctx, key)
	if err != nil {
		if deleteErr := s.Delete(context.WithoutCancel(ctx), key); deleteErr != nil {
			return ErrStorageProbeDeleteFailed
		}
		return ErrStorageProbeFailed
	}
	hash := sha256.New()
	size, readErr := io.Copy(hash, reader)
	closeErr := reader.Close()
	deleteErr := s.Delete(context.WithoutCancel(ctx), key)
	if deleteErr != nil {
		return ErrStorageProbeDeleteFailed
	}
	if readErr != nil || closeErr != nil || size != metadata.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != metadata.SHA256 {
		return ErrStorageProbeFailed
	}
	return nil
}

func (s *AliyunOSSStorage) objectKey(key string) string {
	if s.prefix == "" {
		return strings.TrimLeft(key, "/")
	}
	return s.prefix + "/" + strings.TrimLeft(key, "/")
}

type OSSStorageFactory struct {
	cipher       credentialCipher
	allowedHosts []string
	logger       *zap.Logger
}

func NewOSSStorageFactory(cipher credentialCipher, logger *zap.Logger, allowedHosts ...string) *OSSStorageFactory {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &OSSStorageFactory{cipher: cipher, allowedHosts: append([]string(nil), allowedHosts...), logger: logger}
}

func (f *OSSStorageFactory) NewStorage(_ context.Context, profile StorageProfile) (Storage, error) {
	if err := ValidateOSSProfile(profile, f.allowedHosts); err != nil {
		return nil, err
	}
	var provider credentials.CredentialsProvider
	switch profile.CredentialMode {
	case "ecs_ram_role":
		provider = credentials.NewEcsRoleCredentialsProvider()
	case "access_key":
		if f == nil || f.cipher == nil {
			return nil, ErrStorageUnavailable
		}
		accessKeyID, err := f.cipher.Decrypt(profile.AccessKeyIDCiphertext)
		if err != nil {
			f.logCredentialDecryptionFailure(profile.ProfileID)
			return nil, ErrStorageUnavailable
		}
		accessKeySecret, err := f.cipher.Decrypt(profile.AccessKeySecretCiphertext)
		if err != nil {
			f.logCredentialDecryptionFailure(profile.ProfileID)
			return nil, ErrStorageUnavailable
		}
		provider = credentials.NewStaticCredentialsProvider(string(accessKeyID), string(accessKeySecret))
	default:
		return nil, ErrInvalidStorageConfiguration
	}
	httpClient := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	cfg := oss.LoadDefaultConfig().WithRegion(profile.Region).WithEndpoint(profile.Endpoint).WithCredentialsProvider(provider).WithHttpClient(httpClient).WithRetryMaxAttempts(3)
	parsed, _ := url.Parse(profile.Endpoint)
	if !isOfficialOSSEndpoint(parsed.Hostname()) {
		cfg.WithUseCName(true)
	}
	return NewAliyunOSSStorage(oss.NewClient(cfg), profile.Bucket, profile.ObjectPrefix)
}

func (f *OSSStorageFactory) logCredentialDecryptionFailure(profileID string) {
	f.logger.Error("解密共享文件 OSS 凭据失败", zap.Bool("security_alert", true), zap.String("profile_id", profileID))
}

func ValidateOSSProfile(profile StorageProfile, allowedHosts []string) error {
	parsed, err := url.Parse(strings.TrimSpace(profile.Endpoint))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || (parsed.Port() != "" && parsed.Port() != "443") ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
		return ErrInvalidStorageConfiguration
	}
	host := strings.ToLower(parsed.Hostname())
	if net.ParseIP(host) != nil || host == "localhost" {
		return ErrInvalidStorageConfiguration
	}
	allowed := isOfficialOSSEndpoint(host)
	for _, item := range allowedHosts {
		if strings.EqualFold(strings.TrimSpace(item), host) {
			allowed = true
			break
		}
	}
	if !allowed || !ossRegionPattern.MatchString(strings.TrimSpace(profile.Region)) ||
		!ossBucketPattern.MatchString(strings.TrimSpace(profile.Bucket)) || !validObjectPrefix(profile.ObjectPrefix) {
		return ErrInvalidStorageConfiguration
	}
	if profile.CredentialMode != "ecs_ram_role" && profile.CredentialMode != "access_key" {
		return ErrInvalidStorageConfiguration
	}
	if profile.CredentialMode == "access_key" && (len(profile.AccessKeyIDCiphertext) == 0 || len(profile.AccessKeySecretCiphertext) == 0) {
		return ErrInvalidStorageConfiguration
	}
	return nil
}

func isOfficialOSSEndpoint(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, pattern := range officialOSSEndpointPatterns {
		if pattern.MatchString(host) {
			return true
		}
	}
	return false
}

func validObjectPrefix(prefix string) bool {
	prefix = strings.TrimSpace(prefix)
	if prefix == "" || len(prefix) > 512 || strings.HasPrefix(prefix, "/") || strings.HasSuffix(prefix, "/") || strings.Contains(prefix, "//") {
		return false
	}
	for _, part := range strings.Split(prefix, "/") {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\x00\r\n\\") {
			return false
		}
	}
	return true
}

func normalizeObjectPrefix(prefix string) string { return strings.Trim(strings.TrimSpace(prefix), "/") }

func objectMetadataHeaders(opts PutOptions) map[string]string {
	return map[string]string{"clawee-sha256": opts.SHA256, "clawee-file-id": opts.FileID, "clawee-storage-profile-id": opts.ProfileID}
}

func mapOSSError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	return ErrStorageUnavailable
}

type ossCountingReader struct {
	reader io.Reader
	count  int64
}

func (r *ossCountingReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.count += int64(n)
	return n, err
}
