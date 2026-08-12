package acquire

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"fased-lifecycled/trust"
)

type Downloader struct{ Client *http.Client }

func (downloader Downloader) Fetch(ctx context.Context, rawURL string, asset trust.Asset, inbox *Inbox) (*Object, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("artifact URL must be absolute HTTPS without credentials or fragments")
	}
	client := downloader.Client
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute, CheckRedirect: secureRedirect}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/octet-stream")
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("artifact download returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength >= 0 && uint64(response.ContentLength) != asset.Size {
		return nil, errors.New("artifact HTTP size differs from signed size")
	}
	return inbox.Put(ctx, asset, response.Body)
}

func secureRedirect(request *http.Request, via []*http.Request) error {
	if len(via) >= 3 || request.URL.Scheme != "https" || request.URL.User != nil {
		return errors.New("artifact redirect is unsafe")
	}
	return nil
}
