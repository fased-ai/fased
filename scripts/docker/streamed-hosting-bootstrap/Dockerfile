FROM ubuntu:24.04@sha256:52df9b1ee71626e0088f7d400d5c6b5f7bb916f8f0c82b474289a4ece6cf3faf

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jq \
  && rm -rf /var/lib/apt/lists/*

COPY run.sh /usr/local/bin/fased-streamed-hosting-bootstrap-test
RUN chmod 0755 /usr/local/bin/fased-streamed-hosting-bootstrap-test

ENTRYPOINT ["/usr/local/bin/fased-streamed-hosting-bootstrap-test"]
