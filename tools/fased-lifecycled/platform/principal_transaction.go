package platform

import (
	"context"
	"errors"
	"sort"
)

type principalSnapshot struct {
	users       map[string]bool
	groups      map[string]bool
	memberships map[string]map[string]bool
}

type PrincipalChanges struct {
	system   PrincipalSystem
	before   principalSnapshot
	users    []string
	groups   []string
	finished bool
}

func ProvisionBootstrapPrincipalsTransactional(ctx context.Context, system PrincipalSystem, request BootstrapRequest) (BootstrapPrincipals, *PrincipalChanges, error) {
	names, err := BootstrapPrincipalNames(request.Profile, request.InstanceID, request.OperatorUser)
	if err != nil {
		return BootstrapPrincipals{}, nil, err
	}
	users := []string{names.OperatorUser, names.GatewayUser, names.SignerUser}
	groups := []string{names.GatewayGroup, names.SignerGroup, names.OperatorGroup, names.ConfigGroup}
	if request.Profile == "hosting" {
		groups = append(groups, names.OperatorUser)
	}
	snapshot, err := capturePrincipalSnapshot(ctx, system, users, groups)
	if err != nil {
		return BootstrapPrincipals{}, nil, err
	}
	changes := &PrincipalChanges{system: system, before: snapshot, users: users, groups: groups}
	principals, err := ProvisionBootstrapPrincipals(ctx, system, request)
	if err != nil {
		return BootstrapPrincipals{}, nil, errors.Join(err, changes.Rollback(ctx))
	}
	return principals, changes, nil
}

func capturePrincipalSnapshot(ctx context.Context, system PrincipalSystem, users, groups []string) (principalSnapshot, error) {
	snapshot := principalSnapshot{users: map[string]bool{}, groups: map[string]bool{}, memberships: map[string]map[string]bool{}}
	for _, user := range users {
		_, exists, err := system.LookupUser(ctx, user)
		if err != nil {
			return principalSnapshot{}, err
		}
		snapshot.users[user] = exists
		if exists {
			memberships, err := system.Memberships(ctx, user)
			if err != nil {
				return principalSnapshot{}, err
			}
			snapshot.memberships[user] = memberships
		}
	}
	for _, group := range groups {
		_, exists, err := system.LookupGroup(ctx, group)
		if err != nil {
			return principalSnapshot{}, err
		}
		snapshot.groups[group] = exists
	}
	return snapshot, nil
}

func (changes *PrincipalChanges) Rollback(ctx context.Context) error {
	if changes == nil || changes.finished {
		return nil
	}
	var failures []error
	for _, user := range changes.users {
		if !changes.before.users[user] {
			continue
		}
		current, err := changes.system.Memberships(ctx, user)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		before := changes.before.memberships[user]
		for group := range current {
			if !before[group] {
				failures = append(failures, changes.system.RemoveMembership(ctx, user, group))
			}
		}
		missing := []string{}
		for group := range before {
			if !current[group] {
				missing = append(missing, group)
			}
		}
		sort.Strings(missing)
		if len(missing) > 0 {
			failures = append(failures, changes.system.AddMemberships(ctx, user, missing))
		}
	}
	for index := len(changes.users) - 1; index >= 0; index-- {
		user := changes.users[index]
		if !changes.before.users[user] {
			if _, exists, err := changes.system.LookupUser(ctx, user); err != nil {
				failures = append(failures, err)
			} else if exists {
				failures = append(failures, changes.system.DeleteUser(ctx, user))
			}
		}
	}
	for index := len(changes.groups) - 1; index >= 0; index-- {
		group := changes.groups[index]
		if !changes.before.groups[group] {
			if _, exists, err := changes.system.LookupGroup(ctx, group); err != nil {
				failures = append(failures, err)
			} else if exists {
				failures = append(failures, changes.system.DeleteGroup(ctx, group))
			}
		}
	}
	result := errors.Join(failures...)
	if result == nil {
		changes.finished = true
	}
	return result
}

func (changes *PrincipalChanges) Commit() {
	if changes != nil {
		changes.finished = true
	}
}
