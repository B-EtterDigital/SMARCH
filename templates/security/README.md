# Security documentation template

This README explains the environment-variable contract and row-level-security matrix included with a new project. Brick owners and security reviewers need it when a module reads secrets, touches a database, or stores user-owned data. Read it before implementation and again before the security gate. Remember to record negative access tests, because a policy name alone does not prove isolation.

Copy `env-contract.md` and `rls-matrix.md` into the project documentation, then replace each example row with the module's real variables, actors, operations, policies, and test evidence.
