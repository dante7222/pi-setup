# 1) Show login
```text
User -> LoginForm: submit credentials
LoginForm -> Server: validate
Server -> LoginForm: invalid? error
Server -> LoginForm: valid? create session
LoginForm -> Browser: redirect
```

# 2) Show 40-column pane order
```text
Browser -> API: ask
API -> DB: ask
DB -> API: rows
API -> Browser: JSON
```

# 3) Show SaveButton inside Toolbar inside Page
```text
Page
+-- Toolbar
|   \-- SaveButton

Page owns useSave hook
Toolbar does not own useSave
```

# 4) Show control flow
```text
launch
  image upload || metadata save
  if both succeed
    publish
  else
    abort publish
```

# 5) Show a retry loop with maximum three total attempts and failure exit
```text
attempt = 1
while attempt <= 3
  try action
  if success
    return
  attempt += 1
fail and exit
```

# 6) Show proposed refactor
```text
src/features/session-management/components/
\-- SessionConversationTimeline.tsx
    -> packages/conversation-ui/src/SessionConversationTimeline.tsx
```

# 7) Show a schematic diff adding cache check before write, keeping fresh return
```diff
 on save
+  if cache hit
+    return fresh result
   write content
   return fresh result
```

# 8) Show flow labels 用户, 验证, 成功 in a 40-column pane
```text
用户 -> 验证 -> 成功
```