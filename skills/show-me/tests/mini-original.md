# 1) Login flow
```text
submitCredentials
  server validates
    if invalid
      show error
    if valid
      create session
      redirect
```

# 2) 40-column pane order
```text
Browser
  asks API
API
  asks DB
DB
  returns rows
API
  returns JSON
```

# 3) SaveButton / Toolbar / Page
```tsx
<Page>
  useSave()
  <Toolbar>
    <SaveButton />
  </Toolbar>
</Page>
```

# 4) Concurrent publish gate
```text
publish
  launch image upload || metadata save
  wait for both success
  if either fails
    abort publish
  else
    publish
```

# 5) Retry loop
```text
attempt 1
  try
    success -> done
  fail
attempt 2
  try
    success -> done
  fail
attempt 3
  try
    success -> done
  fail
exit failure
```

# 6) Refactor move
```text
src/features/session-management/components/
  SessionConversationTimeline.tsx

→ packages/conversation-ui/src/
  SessionConversationTimeline.tsx
```

# 7) Cache-before-write diff
```diff
 on(save)
+  if cache is fresh
+    return cached result
   write new content
   return fresh result
```

# 8) Flow labels in 40-column pane
```text
用户
  验证
    成功
```
