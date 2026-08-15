package platform

import (
	"bufio"
	"bytes"
	"errors"
	"regexp"
	"strings"
)

var darwinACLEntryPattern = regexp.MustCompile(`^[0-9]+: ((?:user|group):[A-Za-z_][A-Za-z0-9_.-]{0,127}) (allow|deny) ([a-z_,]+)$`)

func parseDarwinACLListing(data []byte) (map[string]string, []byte, error) {
	entries := map[string]string{}
	canonical := make([]string, 0)
	scanner := bufio.NewScanner(bytes.NewReader(data))
	first := true
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if first {
			first = false
			if line == "" {
				return nil, nil, errors.New("Darwin ACL listing is empty")
			}
			continue
		}
		if line == "" {
			continue
		}
		match := darwinACLEntryPattern.FindStringSubmatch(line)
		if len(match) != 4 {
			return nil, nil, errors.New("owner-home Darwin ACL contains an unsupported entry")
		}
		key, value := match[1], match[2]+" "+match[3]
		if _, exists := entries[key]; exists {
			return nil, nil, errors.New("owner-home Darwin ACL contains a duplicate principal")
		}
		entries[key] = value
		canonical = append(canonical, key+" "+value)
		if len(entries) > 512 {
			return nil, nil, errors.New("owner-home Darwin ACL is unexpectedly large")
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, nil, err
	}
	if first {
		return nil, nil, errors.New("Darwin ACL listing is empty")
	}
	if len(canonical) == 0 {
		return entries, nil, nil
	}
	return entries, []byte(strings.Join(canonical, "\n") + "\n"), nil
}
