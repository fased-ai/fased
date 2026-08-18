package acquire

import (
	"context"
	"errors"
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
	receipt := object.Receipt()
	if receipt.CacheHit || receipt.TransferredBytes != uint64(len(data)) || receipt.DurationMillis == 0 || receipt.FsyncMillis == 0 {
		t.Fatalf("cold acquisition evidence is invalid: %+v", receipt)
	}
	object.Close()
}

func TestDownloaderUsesVerifiedInboxObjectWithoutNetworkTransfer(t *testing.T) {
	data := []byte("signed object bytes")
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		return nil, errors.New("network must not be used for a verified cache hit")
	})}
	inbox, err := OpenInbox(filepath.Join(privateTestRoot(t), "lifecycle"), uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer inbox.Close()
	asset := testAsset("asset", data)
	seeded, err := inbox.Put(context.Background(), asset, strings.NewReader(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	if err := seeded.Close(); err != nil {
		t.Fatal(err)
	}
	object, err := (Downloader{Client: client}).Fetch(context.Background(), "https://fixture.invalid/asset", asset, inbox)
	if err != nil {
		t.Fatal(err)
	}
	defer object.Close()
	receipt := object.Receipt()
	if requests != 0 || !receipt.CacheHit || receipt.TransferredBytes != 0 || receipt.DurationMillis == 0 || receipt.FsyncMillis != 0 {
		t.Fatalf("warm acquisition used the network or lost cache evidence: requests=%d receipt=%+v", requests, receipt)
	}
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
