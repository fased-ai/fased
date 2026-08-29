// Generated from finalized SAT-DEP-0008 deployment evidence; do not edit.

export const SAT_VNEXT_ACTIVATION = {
  $schema: "fased.sat-vnext-activation.v1",
  state: "ACTIVE",
  deploymentId: "SAT-DEP-0008",
  cluster: "devnet",
  interfaceContractSha256:
    "sha256:2232dcb4d977d582ee0d1593d8a0886e620151581b49ebc24f43dbf91a7bbc15", // pragma: allowlist secret
  programs: {
    mining: {
      programId: "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF", // pragma: allowlist secret
      programDataAddress: "3bzGnmBnDhsB2ct3HUVBazrMNpbheizosEZ7H2evjoQu", // pragma: allowlist secret
      deploymentSlot: 489703957,
      allocatedImageSha256:
        "sha256:d63a61af908842530c9786784cabb8f55db08ac5d71b23ac3597a4701b704257", // pragma: allowlist secret
    },
    mint: {
      programId: "71Med1feR4RvP9crdNYtAdMB2YQmSmkbyZhKYRzcRJKL", // pragma: allowlist secret
      programDataAddress: "HwJ6bGHF6iK9adY2eMTHHyqEEoFtU1oxRF2GypFpUQ8E", // pragma: allowlist secret
      deploymentSlot: 488411168,
      allocatedImageSha256:
        "sha256:c82b8a5e5f83bb451f6a714840db193d68242928633606e12bced83a66d44a45", // pragma: allowlist secret
    },
    bond: {
      programId: "5peszKe8y7dv8KqdSse9UFxmaLxGsy7pWJBm6KpGnGA3", // pragma: allowlist secret
      programDataAddress: "HDRZP9bxzmhCcAAtkjL9giJ6zmY1pXjeTfb6zo9aXznw", // pragma: allowlist secret
      deploymentSlot: 489112812,
      allocatedImageSha256:
        "sha256:ce67a62d347c30ef988c1db40a78b3248823e8b2222875b72812200cf25bf6aa", // pragma: allowlist secret
    },
  },
  satMint: "BbZ7cUmbD9s43jeqK65Jjg8QWo5VNMZovKURVEYx4DqU", // pragma: allowlist secret
  protocolGenerationState: {
    address: "4bAddyonLtrQmAKfASHgpUHqaxYY7fU48yrXV7JJrBzE", // pragma: allowlist secret
    accountSha256: "sha256:55c142262baaa6b5db096c3ef0f253e122ba1a0008b9b4faf839cc56dde4cc83", // pragma: allowlist secret
    publicEntryEnabled: true,
    activationGeneration: 4,
    componentTupleHex: "0100020002000300030003000300020002000200", // pragma: allowlist secret
    economicsContractSha256:
      "sha256:ec935a84a00d6bd8269b856b84328684e3d977a5f0fb758fd3884cd310a6934c", // pragma: allowlist secret
  },
  activation: {
    signature:
      "h4MM1BCSWp3qLwJCRSVWDhJzBFAye7h5CytJGrMEGPgJaUduH4Bi2ShdfeGvh5LUjbRWnK7Ut9C3Sozssg6ArCM", // pragma: allowlist secret
    finalizedSlot: 489778039,
    receiptDigest: "sha256:b306d2edcd6e1c3b6946383aedea11eaad0d6ad7db7162fe156813a3bf31a61b", // pragma: allowlist secret
  },
  replacementDeployment: {
    signature:
      "9JLKNB5CEYNmJQRzCjwZBKx9wSuAJvJwa6LH2KC2cpbZrzFmLsXSTNeZ2sRP9wo3GscxWRzzJdfg3mpfnh2qQcK", // pragma: allowlist secret
    finalizedSlot: 489703957,
    descriptorSha256: "sha256:6d92f2b93a273e4bd1c8daa6fc9e45681964e11850b99307b5e5998388909569", // pragma: allowlist secret
    artifactSha256: "sha256:399a627e5ad851308757a1077b2f2223d5b30853e75e36eb964b3d5d5a52047e", // pragma: allowlist secret
    artifactBytes: 754408,
    allocatedImageSha256: "sha256:d63a61af908842530c9786784cabb8f55db08ac5d71b23ac3597a4701b704257", // pragma: allowlist secret
    allocatedImageBytes: 764176,
    zeroPaddingBytes: 9768,
  },
} as const;
