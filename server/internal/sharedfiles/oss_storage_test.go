package sharedfiles

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

func TestAliyunOSSStorageSmallObjectContract(t *testing.T) {
	client := newFakeOSSClient()
	storage, err := NewAliyunOSSStorage(client, "bucket", "clawee/shared-files")
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("hello oss")
	metadata, err := storage.Put(context.Background(), "space_a/file_a/blob_a", bytes.NewReader(content), PutOptions{
		DeclaredSize: int64(len(content)), MaxBytes: 100, ContentType: "text/plain", FileID: "file_a", ProfileID: "profile_a",
	})
	if err != nil {
		t.Fatal(err)
	}
	if metadata.SizeBytes != int64(len(content)) || metadata.SHA256 != "c4584b9f5a9cbd6b07964a663cfc48e46567e507ef133da6a76827486f38d6bd" {
		t.Fatalf("metadata = %#v", metadata)
	}
	objectKey := "clawee/shared-files/space_a/file_a/blob_a"
	if string(client.objects[objectKey]) != string(content) {
		t.Fatalf("stored object = %q", client.objects[objectKey])
	}
	if client.metadata[objectKey]["clawee-sha256"] != metadata.SHA256 ||
		client.metadata[objectKey]["clawee-file-id"] != "file_a" ||
		client.metadata[objectKey]["clawee-storage-profile-id"] != "profile_a" {
		t.Fatalf("object metadata = %#v", client.metadata[objectKey])
	}
	reader, err := storage.Open(context.Background(), "space_a/file_a/blob_a")
	if err != nil {
		t.Fatal(err)
	}
	opened, _ := io.ReadAll(reader)
	_ = reader.Close()
	if string(opened) != string(content) {
		t.Fatalf("opened = %q", opened)
	}
	if err := storage.Delete(context.Background(), "space_a/file_a/blob_a"); err != nil {
		t.Fatal(err)
	}
	if err := storage.Delete(context.Background(), "space_a/file_a/blob_a"); err != nil {
		t.Fatalf("repeated delete = %v", err)
	}
}

func TestAliyunOSSStorageMultipartAndAbort(t *testing.T) {
	client := newFakeOSSClient()
	storage, _ := NewAliyunOSSStorage(client, "bucket", "prefix")
	storage.partSize = 4
	content := []byte("0123456789")
	metadata, err := storage.Put(context.Background(), "space_a/file_a/blob_a", bytes.NewReader(content), PutOptions{
		DeclaredSize: 10, MaxBytes: 10, FileID: "file_a", ProfileID: "profile_a",
	})
	if err != nil || metadata.SizeBytes != 10 || client.completeCalls != 1 || client.abortCalls != 0 {
		t.Fatalf("multipart result = %#v, %v complete=%d abort=%d", metadata, err, client.completeCalls, client.abortCalls)
	}
	client.failPart = 2
	_, err = storage.Put(context.Background(), "space_a/file_a/blob_b", bytes.NewReader(content), PutOptions{
		DeclaredSize: 10, MaxBytes: 10, FileID: "file_a", ProfileID: "profile_a",
	})
	if !errors.Is(err, ErrStorageUnavailable) || client.abortCalls != 1 {
		t.Fatalf("failed multipart error=%v abort=%d", err, client.abortCalls)
	}
	client.failPart = 0
	client.completeErr = errors.New("complete failed")
	_, err = storage.Put(context.Background(), "space_a/file_a/blob_c", bytes.NewReader(content), PutOptions{
		DeclaredSize: 10, MaxBytes: 10, FileID: "file_a", ProfileID: "profile_a",
	})
	if !errors.Is(err, ErrStorageUnavailable) || client.abortCalls != 2 {
		t.Fatalf("failed completion error=%v abort=%d", err, client.abortCalls)
	}
}

func TestAliyunOSSStorageAbortsMultipartAfterContextCancellation(t *testing.T) {
	client := newFakeOSSClient()
	storage, _ := NewAliyunOSSStorage(client, "bucket", "prefix")
	storage.partSize = 4
	ctx, cancel := context.WithCancel(context.Background())
	client.beforeUploadPart = cancel
	_, err := storage.Put(ctx, "space_a/file_a/blob_a", strings.NewReader("0123456789"), PutOptions{
		DeclaredSize: 10, MaxBytes: 10, FileID: "file_a", ProfileID: "profile_a",
	})
	if !errors.Is(err, context.Canceled) || client.abortCalls != 1 || client.abortContextErr != nil {
		t.Fatalf("cancelled multipart error=%v abort=%d abort_context=%v", err, client.abortCalls, client.abortContextErr)
	}
}

func TestAliyunOSSStorageProbe(t *testing.T) {
	storage, _ := NewAliyunOSSStorage(newFakeOSSClient(), "bucket", "prefix")
	if err := storage.Probe(context.Background()); err != nil {
		t.Fatalf("successful probe = %v", err)
	}

	for _, test := range []struct {
		name      string
		configure func(*fakeOSSClient)
		want      error
	}{
		{name: "put", configure: func(client *fakeOSSClient) { client.putErr = errors.New("put failed") }, want: ErrStorageProbeFailed},
		{name: "get", configure: func(client *fakeOSSClient) { client.getErr = errors.New("get failed") }, want: ErrStorageProbeFailed},
		{name: "content", configure: func(client *fakeOSSClient) { client.corruptGet = true }, want: ErrStorageProbeFailed},
		{name: "delete", configure: func(client *fakeOSSClient) { client.deleteErr = errors.New("delete failed") }, want: ErrStorageProbeDeleteFailed},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := newFakeOSSClient()
			test.configure(client)
			storage, _ := NewAliyunOSSStorage(client, "bucket", "prefix")
			if err := storage.Probe(context.Background()); !errors.Is(err, test.want) {
				t.Fatalf("probe error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestAliyunOSSStorageMapsOpenAndDeleteErrors(t *testing.T) {
	client := newFakeOSSClient()
	client.getErr = errors.New("get failed")
	client.deleteErr = errors.New("delete failed")
	storage, _ := NewAliyunOSSStorage(client, "bucket", "prefix")
	if _, err := storage.Open(context.Background(), "space_a/file_a/blob_a"); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("open error = %v", err)
	}
	if err := storage.Delete(context.Background(), "space_a/file_a/blob_a"); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("delete error = %v", err)
	}
}

func TestAliyunOSSStorageRejectsInvalidInputAndEndpoint(t *testing.T) {
	client := newFakeOSSClient()
	storage, _ := NewAliyunOSSStorage(client, "bucket", "prefix")
	if _, err := storage.Put(context.Background(), "space_a/file_a/blob_a", strings.NewReader("short"), PutOptions{DeclaredSize: 6, MaxBytes: 10}); !errors.Is(err, ErrContentLengthMismatch) {
		t.Fatalf("size mismatch = %v", err)
	}
	if _, err := storage.Put(context.Background(), "space_a/file_a/blob_b", strings.NewReader("too large"), PutOptions{DeclaredSize: 11, MaxBytes: 10}); !errors.Is(err, ErrFileTooLarge) || client.putCalls != 0 {
		t.Fatalf("oversized declaration error=%v put_calls=%d", err, client.putCalls)
	}
	valid := StorageProfile{Endpoint: "https://oss-cn-hangzhou-internal.aliyuncs.com", Region: "cn-hangzhou", Bucket: "bucket",
		ObjectPrefix: "clawee/shared-files", CredentialMode: "ecs_ram_role"}
	if err := ValidateOSSProfile(valid, nil); err != nil {
		t.Fatalf("official endpoint = %v", err)
	}
	for _, endpoint := range []string{
		"http://oss-cn-hangzhou.aliyuncs.com",
		"https://user@oss-cn-hangzhou.aliyuncs.com",
		"https://oss-cn-hangzhou.aliyuncs.com/path",
		"https://oss-cn-hangzhou.aliyuncs.com?query=1",
		"https://127.0.0.1",
		"https://oss-cn-hangzhou.aliyuncs.com:8443",
	} {
		invalid := valid
		invalid.Endpoint = endpoint
		if err := ValidateOSSProfile(invalid, nil); !errors.Is(err, ErrInvalidStorageConfiguration) {
			t.Fatalf("endpoint %q error = %v", endpoint, err)
		}
	}
	custom := valid
	custom.Endpoint = "https://storage.example.com"
	if err := ValidateOSSProfile(custom, []string{"storage.example.com"}); err != nil {
		t.Fatalf("allowed CNAME = %v", err)
	}
	custom.Endpoint = "https://127.0.0.1"
	if err := ValidateOSSProfile(custom, []string{"127.0.0.1"}); !errors.Is(err, ErrInvalidStorageConfiguration) {
		t.Fatalf("allowed IP endpoint error = %v", err)
	}
}

func TestOSSStorageFactoryLogsCredentialDecryptionFailureWithoutSecret(t *testing.T) {
	core, logs := observer.New(zap.ErrorLevel)
	factory := NewOSSStorageFactory(failingCredentialCipher{}, zap.New(core))
	profile := StorageProfile{ProfileID: "profile-a", Endpoint: "https://oss-cn-hangzhou.aliyuncs.com", Region: "cn-hangzhou",
		Bucket: "clawee-test", ObjectPrefix: "shared-files", CredentialMode: "access_key",
		AccessKeyIDCiphertext: []byte("cipher-id"), AccessKeySecretCiphertext: []byte("cipher-secret")}
	if _, err := factory.NewStorage(context.Background(), profile); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("factory error = %v", err)
	}
	if logs.Len() != 1 || logs.All()[0].ContextMap()["security_alert"] != true || strings.Contains(logs.All()[0].Message, "cipher") {
		t.Fatalf("logs = %#v", logs.All())
	}
}

type failingCredentialCipher struct{}

func (failingCredentialCipher) Encrypt([]byte) ([]byte, error) {
	return nil, errors.New("encrypt failed")
}
func (failingCredentialCipher) Decrypt([]byte) ([]byte, error) {
	return nil, errors.New("decrypt failed")
}

type fakeOSSClient struct {
	objects          map[string][]byte
	metadata         map[string]map[string]string
	parts            map[int32][]byte
	multipartKey     string
	multipartMeta    map[string]string
	failPart         int32
	putErr           error
	getErr           error
	deleteErr        error
	completeErr      error
	corruptGet       bool
	beforeUploadPart func()
	putCalls         int
	completeCalls    int
	abortCalls       int
	abortContextErr  error
}

func newFakeOSSClient() *fakeOSSClient {
	return &fakeOSSClient{objects: map[string][]byte{}, metadata: map[string]map[string]string{}, parts: map[int32][]byte{}}
}

func (c *fakeOSSClient) PutObject(_ context.Context, request *oss.PutObjectRequest, _ ...func(*oss.Options)) (*oss.PutObjectResult, error) {
	c.putCalls++
	if c.putErr != nil {
		return nil, c.putErr
	}
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	c.objects[oss.ToString(request.Key)] = body
	c.metadata[oss.ToString(request.Key)] = request.Metadata
	return &oss.PutObjectResult{}, nil
}

func (c *fakeOSSClient) GetObject(_ context.Context, request *oss.GetObjectRequest, _ ...func(*oss.Options)) (*oss.GetObjectResult, error) {
	if c.getErr != nil {
		return nil, c.getErr
	}
	body, ok := c.objects[oss.ToString(request.Key)]
	if !ok {
		return nil, errors.New("not found")
	}
	if c.corruptGet && len(body) > 0 {
		body = append([]byte(nil), body...)
		body[0] ^= 0xff
	}
	return &oss.GetObjectResult{Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body))}, nil
}

func (c *fakeOSSClient) DeleteObject(_ context.Context, request *oss.DeleteObjectRequest, _ ...func(*oss.Options)) (*oss.DeleteObjectResult, error) {
	if c.deleteErr != nil {
		return nil, c.deleteErr
	}
	delete(c.objects, oss.ToString(request.Key))
	return &oss.DeleteObjectResult{}, nil
}

func (c *fakeOSSClient) InitiateMultipartUpload(_ context.Context, request *oss.InitiateMultipartUploadRequest, _ ...func(*oss.Options)) (*oss.InitiateMultipartUploadResult, error) {
	c.parts = map[int32][]byte{}
	c.multipartKey = oss.ToString(request.Key)
	c.multipartMeta = request.Metadata
	return &oss.InitiateMultipartUploadResult{UploadId: oss.Ptr("upload-1")}, nil
}

func (c *fakeOSSClient) UploadPart(ctx context.Context, request *oss.UploadPartRequest, _ ...func(*oss.Options)) (*oss.UploadPartResult, error) {
	if c.beforeUploadPart != nil {
		c.beforeUploadPart()
		c.beforeUploadPart = nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if request.PartNumber == c.failPart {
		return nil, errors.New("part failed")
	}
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	c.parts[request.PartNumber] = body
	return &oss.UploadPartResult{ETag: oss.Ptr("etag")}, nil
}

func (c *fakeOSSClient) CompleteMultipartUpload(_ context.Context, request *oss.CompleteMultipartUploadRequest, _ ...func(*oss.Options)) (*oss.CompleteMultipartUploadResult, error) {
	if c.completeErr != nil {
		return nil, c.completeErr
	}
	var body []byte
	for _, part := range request.CompleteMultipartUpload.Parts {
		body = append(body, c.parts[part.PartNumber]...)
	}
	c.objects[c.multipartKey] = body
	c.metadata[c.multipartKey] = c.multipartMeta
	c.completeCalls++
	return &oss.CompleteMultipartUploadResult{}, nil
}

func (c *fakeOSSClient) AbortMultipartUpload(ctx context.Context, _ *oss.AbortMultipartUploadRequest, _ ...func(*oss.Options)) (*oss.AbortMultipartUploadResult, error) {
	c.abortCalls++
	c.abortContextErr = ctx.Err()
	return &oss.AbortMultipartUploadResult{}, nil
}
