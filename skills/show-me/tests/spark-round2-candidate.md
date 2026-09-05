## 1) Login flow: invalid credentials error, valid credentials session + redirect
```text
User -> LoginForm: submit credentials
LoginForm -> Server: validate credentials
Server -> LoginForm: invalid credentials
LoginForm -> UI: show error

LoginForm -> Server: valid credentials
Server -> Session: create session
Server -> Browser: redirect
```

## 2) 40-column order: Browser -> API -> DB
```text
1. Browser -> API: request
2. API -> DB: query
3. DB -> API: rows
4. API -> Browser: JSON
```

## 3) Ownership: SaveButton inside Toolbar inside Page
```text
Page [owns useSave]
\-- Toolbar
    \-- SaveButton
```

## 4) Parallel launch image upload and metadata save; publish after both succeed
```text
on publish
  start imageUpload and metadataSave in parallel
  wait for both
  if both succeed
    publish
  else
    abort publish
```

## 5) Retry loop: max three total attempts then fail
```text
attempt = 1
while attempt <= 3
  try action
  if success
    return success
  attempt += 1
fail after 3 attempts
```

## 6) Proposed file move refactor
```text
src/features/session-management/components/
\-- SessionConversationTimeline.tsx

packages/conversation-ui/src/
\-- SessionConversationTimeline.tsx
```

## 7) Schematic diff: add cache check before write, keep fresh return
```diff
 on save
+  if cache hit
+    return cached result
   write content
   return fresh result
```

## 8) 40-column flow labels 用户, 验证, 成功
```text
用户 -> 验证 -> 成功
```