# Asterisk PBX that the Android cellular<->SIP gateway (Voice SIP Agent) registers to.
# Built from Ubuntu's own package rather than a community image. Run with --network host:
# the phone only accepts INVITEs whose source IP is the registrar it connected to, so a
# NAT'd bridge network would get every inbound call rejected with 403.
FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends asterisk asterisk-modules \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /etc/asterisk/* \
 && mkdir -p /var/run/asterisk && chown asterisk:asterisk /var/run/asterisk
USER asterisk
CMD ["asterisk", "-f", "-vvv"]
