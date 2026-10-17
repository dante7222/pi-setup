1) Login flow
```text
submit credentials
  -> server validates
  if invalid
    show error
  else
    create session
    redirect
```

2) 40-column pane order
```text
Browser -> API: ask
API -> DB: ask
DB -> API: rows
API -> Browser: JSON
```

3) Ownership / nesting
```text
Page [owns useSave]
\-- Toolbar
    \-- SaveButton
```

4) Concurrent upload + save
```text
start both
  image upload
  metadata save
wait for both
  if either fails
    abort publish
  else
    publish
```

5) Retry loop, max 3 attempts
```text
attempt = 1
while attempt <= 3
  try action
  if success
    stop
  else if attempt == 3
    fail and exit
  else
    attempt++
```

6) Proposed refactor move
```text
src/features/session-management/components/
  SessionConversationTimeline.tsx
  -> packages/conversation-ui/src/SessionConversationTimeline.tsx
```

7) Schematic diff
```diff
 on save
+  if cache hit
+    return cached result
   write content
   return fresh result
```

8) Flow labels in 40 columns
```text
用户 -> 验证 -> 成功
```
