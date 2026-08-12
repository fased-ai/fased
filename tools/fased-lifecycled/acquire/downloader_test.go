package acquire

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDownloaderStreamsExactHTTPSObject(t *testing.T) {
	data := []byte("signed object bytes")
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Length": []string{"19"}}, ContentLength: 19, Body: io.NopCloser(strings.NewReader(string(data))), Request: request}, nil
	})}
	inbox, err := OpenInbox(filepath.Join(privateTestRoot(t), "lifecycle"), uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer inbox.Close()
	object, err := (Downloader{Client: client}).Fetch(context.Background(), "https://fixture.invalid/asset", testAsset("asset", data), inbox)
	if err != nil {
		t.Fatal(err)
	}
	object.Close()
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestDownloaderRejectsNonHTTPSAndUnsafeRedirect(t *testing.T) {
	if _, err := (Downloader{}).Fetch(context.Background(), "http://example.invalid/asset", testAsset("asset", []byte("x")), nil); err == nil {
		t.Fatal("plain HTTP was accepted")
	}
	if err := secureRedirect(&http.Request{URL: mustURL(t, "http://example.invalid")}, nil); err == nil {
		t.Fatal("redirect downgrade was accepted")
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
