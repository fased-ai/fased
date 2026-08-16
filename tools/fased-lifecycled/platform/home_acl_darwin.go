//go:build darwin

package platform

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

type DarwinACL struct {
	ls, chmod, id string
	runner        ACLCommandRunner
}

var darwinACLAccountPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]{0,127}$`)

func NewHomeACL() (HomeACL, error) {
	commands := map[string]string{"ls": "/bin/ls", "chmod": "/bin/chmod", "id": "/usr/bin/id"}
	for name, path := range commands {
		info, err := os.Lstat(path)
		stat, ok := infoSysStat(info)
		if err != nil || !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || info.Mode().Perm()&0o111 == 0 || stat.Uid != 0 {
			return nil, fmt.Errorf("required Darwin ACL command %s is unavailable or unsafe", name)
		}
	}
	return &DarwinACL{ls: commands["ls"], chmod: commands["chmod"], id: commands["id"], runner: execACLRunner{}}, nil
}

func (acl *DarwinACL) account(ctx context.Context, uid uint32) (string, error) {
	if acl == nil || acl.runner == nil || uid == 0 {
		return "", errors.New("Darwin ACL account lookup is unavailable")
	}
	output, err := acl.runner.Run(ctx, acl.id, []string{"-nu", strconv.FormatUint(uint64(uid), 10)}, nil)
	name := strings.TrimSpace(string(output))
	if err != nil || !darwinACLAccountPattern.MatchString(name) || strings.Contains(name, "\n") {
		return "", errors.Join(err, errors.New("Darwin ACL account identity is invalid"))
	}
	return name, nil
}

func (acl *DarwinACL) Capture(ctx context.Context, directory string) (ACLSnapshot, error) {
	if acl == nil || acl.runner == nil || acl.ls == "" {
		return ACLSnapshot{}, errors.New("Darwin ACL support is unavailable before mutation")
	}
	output, err := acl.runner.Run(ctx, acl.ls, []string{"-lde", directory}, nil)
	if err != nil {
		return ACLSnapshot{}, err
	}
	entries, canonical, err := parseDarwinACLListing(output)
	if err != nil {
		return ACLSnapshot{}, err
	}
	return ACLSnapshot{raw: canonical, entries: entries}, nil
}

func (acl *DarwinACL) HasExactTraversal(snapshot ACLSnapshot, gatewayUID uint32) (bool, error) {
	name, err := acl.account(context.Background(), gatewayUID)
	if err != nil {
		return false, err
	}
	value, exists := snapshot.entries["user:"+name]
	if !exists {
		return false, nil
	}
	if value != "allow search" {
		return false, errors.New("existing Gateway owner-home ACL is broader than traversal")
	}
	return true, nil
}

func (acl *DarwinACL) GrantTraversal(ctx context.Context, directory string, gatewayUID uint32, original ACLSnapshot) error {
	name, err := acl.account(ctx, gatewayUID)
	if err != nil {
		return err
	}
	key := "user:" + name
	if _, exists := original.entries[key]; exists {
		return errors.New("Gateway UID collides with an existing owner-home ACL entry")
	}
	entry := key + " allow search"
	if _, err := acl.runner.Run(ctx, acl.chmod, []string{"+a#", "0", entry, directory}, nil); err != nil {
		return err
	}
	current, err := acl.Capture(ctx, directory)
	if err != nil {
		return err
	}
	if current.entries[key] != "allow search" {
		return errors.New("Gateway did not receive exact owner-home traversal")
	}
	for originalKey, value := range original.entries {
		if current.entries[originalKey] != value {
			return errors.New("owner-home ACL changed an existing entry")
		}
	}
	if len(current.entries) != len(original.entries)+1 {
		return errors.New("owner-home ACL gained an unexpected entry")
	}
	return nil
}

func (acl *DarwinACL) Restore(ctx context.Context, directory string, snapshot ACLSnapshot) error {
	arguments := []string{"-N", directory}
	input := []byte(nil)
	if len(snapshot.entries) > 0 {
		if len(snapshot.raw) == 0 {
			return errors.New("Darwin ACL rollback snapshot is invalid")
		}
		arguments = []string{"-E", directory}
		input = snapshot.raw
	}
	if _, err := acl.runner.Run(ctx, acl.chmod, arguments, input); err != nil {
		return err
	}
	current, err := acl.Capture(ctx, directory)
	if err != nil {
		return err
	}
	if !sameACL(current.entries, snapshot.entries) {
		return errors.New("owner-home ACL was not restored exactly")
	}
	return nil
}
