# Security policy

## Supported version

Security fixes currently target the latest release in the 0.1.x line.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose credentials,
execute unintended SQL, misclassify unsafe DDL as deployable, or bypass the read-only
live-analysis boundary.

Use GitHub's private vulnerability reporting for this repository. Include a minimal
reproduction, affected version, expected behavior, and impact. You should receive an
initial response within seven days.

## Operational safety

SQLSage does not execute candidate indexes or rewritten queries. Live planning uses a
read-only transaction and timeout. `--analyze` does execute the supplied `SELECT`, and
database read-only mode cannot prevent external side effects inside user-defined
functions. Review unfamiliar SQL and connection targets before opting in.
