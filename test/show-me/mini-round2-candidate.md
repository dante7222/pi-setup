# 1) Login flow
```text
User -> Login form: submit credentials
Login form -> Server: credentials
Server -> Server: validate
Server -> Login form: error (invalid)
Server -> Session: create (valid)
Server -> Browser: redirect
```

# 2) 40-column pane order
```text
Browser -> API: ask
API -> DB: ask
DB -> API: rows
API -> Browser: JSON
```

# 3) SaveButton ownership
```text
Page [owns useSave hook]
\-- Toolbar
    \-- SaveButton
```

# 4) Concurrent upload and save
```text
start both
  launch image upload
  save metadata
wait for both
if both succeed
  publish
else
  abort publish
```

# 5) Retry loop
```text
attempt = 1
while attempt <= 3
  try
    action
    return success
  catch failure
    if attempt == 3
      exit failure
    attempt++
```

# 6) Proposed refactor
```text
src/features/session-management/components/SessionConversationTimeline.tsx
-> packages/conversation-ui/src/SessionConversationTimeline.tsx
```

# 7) Cache check before write
```diff
 on save
+  if cache is fresh
+    return cached result
   write content
   return fresh result
```

# 8) 40-column pane flow labels
```text
用户 -> 验证 -> 成功
```