// Generated from finalized SAT-DEP-0010 deployment evidence; do not edit.

export const SAT_VNEXT_ACTIVATION = {
  $schema: "fased.sat-vnext-activation.v1",
  state: "FROZEN_NOT_ACTIVE",
  deploymentId: "SAT-DEP-0010",
  cluster: "devnet",
  interfaceContractSha256:
    "sha256:09047a1f194bcb85cbf8ff34519a3be563a7cea487c48f009fa314c6254f8cba", // pragma: allowlist secret
  programs: {
    mining: {
      programId: "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF", // pragma: allowlist secret
      programDataAddress: "3bzGnmBnDhsB2ct3HUVBazrMNpbheizosEZ7H2evjoQu", // pragma: allowlist secret
      deploymentSlot: 490137333,
      allocatedImageSha256:
        "sha256:45c7be4865f68813e1ab6545e0d891dbfbafbd1f9599018476beb5852876d00d", // pragma: allowlist secret
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
    accountSha256: "sha256:21d2d721dc7ebd671fb91c631664d2c94ef9d4f98caa529e624c28b632367fc5", // pragma: allowlist secret
    publicEntryEnabled: false,
    activationGeneration: 7,
    componentTupleHex: "0100020002000300030003000300020002000200", // pragma: allowlist secret
    economicsContractSha256:
      "sha256:ec935a84a00d6bd8269b856b84328684e3d977a5f0fb758fd3884cd310a6934c", // pragma: allowlist secret
  },
  activation: {
    signature:
      "1XtYvooJBH2zGNtMfHLyvCCp9awE9MNRpkgkAyjamgTeLMRsfThHeCQ6VLJrRNEm1AVCdjcuNFEeCXtT9ApM4Nh", // pragma: allowlist secret
    finalizedSlot: 490068035,
    receiptDigest: "sha256:2f71ea52f246f8cb559b8022c3967e4b4a70fde2d0cff8a1bbffd06026316ab7", // pragma: allowlist secret
  },
  replacementDeployment: {
    signature:
      "5nYwtkoxZyQw6oXbXchU9y2LWdc3PzoaEMfBb9mptJGZ76TRVUT17bBJzNyV7DmPJY1jEpJXKgiKdykafgL9gz92", // pragma: allowlist secret
    finalizedSlot: 490137333,
    descriptorSha256: "sha256:1da47f9e9b4ff577935f810f6f89a8938d66d60d0461753fb286bdf4ea2f09a4", // pragma: allowlist secret
    artifactSha256: "sha256:bd17ca6ea0a509b0e36132ba11bc8e227004e752dbf19e87a4a7b441d8af25e5", // pragma: allowlist secret
    artifactBytes: 758144,
    allocatedImageSha256: "sha256:45c7be4865f68813e1ab6545e0d891dbfbafbd1f9599018476beb5852876d00d", // pragma: allowlist secret
    allocatedImageBytes: 764176,
    zeroPaddingBytes: 6032,
  },
} as const;
