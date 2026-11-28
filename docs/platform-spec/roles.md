# Platform spec: custom roles

Owners and admins can do everything in the console. Custom roles let an owner
hand out part of that, such as a "Knowledge editor" who manages documents or
an "Auditor" who reads the audit log, without making the person an admin.

## Permissions

| Permission | Allows |
|---|---|
| `people` | See people and teams; manage manual teams |
| `access` | See and change access rules; check anyone's access |
| `requests` | See and decide everyone's access requests |
| `knowledge` | Manage knowledge documents and section labels |
| `library` | Manage skills, connections and plugins |
| `audit` | Read and export the audit log |
| `usage` | See model usage |

## Rules

- A custom role is a name and a set of permissions. A member holds at most one.
- Owners and admins always have every permission; a custom role only adds
  permissions to a `member`.
- Only owners create, change and delete custom roles and give them to people,
  so nobody can grant themselves more.
- Owner-only actions (changing built-in roles, the SCIM token) never come from
  a custom role.
- Deleting a role takes its permissions away from everyone who held it.
- `GET /v1/me` lists the member's permissions so the console shows only the
  pages they can use.
- Every role change is audited.
