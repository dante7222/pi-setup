1) Login flow (submit credentials)

```text
on submit credentials
  -> server validates
  if invalid
    -> show error
  else
    -> create session
    -> redirect user
```

2) 40-column pane order

```text
40-column pane
Browser -> API: fetch()
API    -> DB : query
DB     -> API: rows
API    -> Browser: JSON
```

3) Ownership: SaveButton in Toolbar in Page

```text
Page
\-- hook: useSave
\-- Toolbar
    \-- SaveButton
```

4) Concurrent image upload + metadata save, then publish

```text
on publish request
  start image_upload
  start metadata_save   (parallel)
  wait for both
  if both succeed
    -> publish
  else
    -> abort publish
    -> return failure
```

5) Retry loop (max 3 attempts)

```text
attempt = 1
while attempt <= 3
  -> run operation
  if success
    -> return success
  else
    if attempt == 3
      -> return failure
    else
      attempt++
      retry
```

6) Proposed refactor move

```text
A -> B
```
A: `src/features/session-management/components/SessionConversationTimeline.tsx`  
B: `packages/conversation-ui/src/SessionConversationTimeline.tsx`

7) Schematic diff: cache check before write (fresh return kept)

```diff
on save
+  if cache hit
+    return cached result
   write content
   return fresh result
```

8) 40-column labeled flow (用户 / 验证 / 成功)

```text
用户 -> 验证
验证 -> 失败
验证 -> 成功
失败 -> 用户
成功 -> API -> DB -> 响应
```
