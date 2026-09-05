## Case 1 — Login branching (invalid/error vs valid/create session/redirect)
```text
on submitLogin
  if credentials invalid
    show error
    stop
  else
    create session
    redirect to app
```

## Case 2 — API/database flow in a 40-column pane
```text
Browser -> API: request
  API -> DB: query
  DB -> API: rows
API -> Browser: JSON
```

## Case 3 — Ownership: Page -> Toolbar -> SaveButton
```text
SessionPage
+-- useSave
\-- Toolbar
    \-- SaveButton
```

## Case 4 — Upload + metadata before publish
```text
on publish
  start uploadImage, saveMetadata in parallel
  if uploadImage ok AND saveMetadata ok
    publish
  else
    abort publish
    show error
```

## Case 5 — Retry limit (max three attempts)
```text
attempts = 0
while attempts < 3
  if operation succeeds
    return success
  attempts += 1
if attempts == 3
  return error
```

## Case 6 — Proposed file move
```diff
-src/features/session-management/components/
-  SessionConversationTimeline.tsx
+packages/conversation-ui/src/
+  SessionConversationTimeline.tsx
```