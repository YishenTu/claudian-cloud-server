# Claudian Cloud Server

Claudian Cloud Server is the public, auditable collaboration data plane for
Claudian Collab. It provides canonical Project repositories and coordination
services while Claudian coding agents and private work remain on participant
devices.

User authentication is outside this repository. Deployments must provide their
own trusted ingress and authentication system. Claudian Cloud Server accepts
the resulting trusted caller identity and handles Project membership and
authorization for admitted requests.
