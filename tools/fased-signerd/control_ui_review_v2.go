package main

func allowsControlUIReviewIntentV2(intent signerIntentV2, role string) bool {
	return isTypedTransferIntentV2(intent.Type) && role == "agent"
}
