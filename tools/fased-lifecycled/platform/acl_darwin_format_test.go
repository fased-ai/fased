package platform

import "testing"

func TestParseDarwinACLListingPreservesExactOrderedEntries(t *testing.T) {
	listing := []byte("drwx------+ 42 owner staff 1344 Aug 15 12:00 /Users/owner\n 0: user:existing allow read,search\n 1: group:staff deny delete\n")
	entries, canonical, err := parseDarwinACLListing(listing)
	if err != nil {
		t.Fatal(err)
	}
	if entries["user:existing"] != "allow read,search" || entries["group:staff"] != "deny delete" || string(canonical) != "user:existing allow read,search\ngroup:staff deny delete\n" {
		t.Fatalf("unexpected Darwin ACL normalization: %+v %q", entries, canonical)
	}
}

func TestParseDarwinACLListingAcceptsNoExtendedACLAndRejectsAmbiguity(t *testing.T) {
	entries, canonical, err := parseDarwinACLListing([]byte("drwx------ 42 owner staff 1344 Aug 15 12:00 /Users/owner\n"))
	if err != nil || len(entries) != 0 || len(canonical) != 0 {
		t.Fatalf("ordinary Darwin mode was not accepted: %+v %q %v", entries, canonical, err)
	}
	if _, _, err := parseDarwinACLListing([]byte("drwx------+ x\n 0: user:owner allow search\n 1: user:owner allow read\n")); err == nil {
		t.Fatal("duplicate Darwin ACL principal was accepted")
	}
}
