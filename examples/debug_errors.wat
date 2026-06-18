(module
  ;; WAT file with intentional errors for testing error location

  (func $stack_error (export "stack_error") (param $a i32) (result i32)
    ;; Type mismatch: expecting i32 on stack but trying to add
    local.get $a
    f32.const 3.14
    i32.add
  )

  (func $unknown_call (export "unknown_call") (result i32)
    ;; Call to non-existent function
    call $nonexistent_func
  )

  (func $bad_branch (export "bad_branch") (result i32)
    block $myblock
      i32.const 1
      ;; Branch to non-existent label
      br $nonexistent_label
    end
    i32.const 0
  )

  (func $local_error (export "local_error") (result i32)
    ;; Access non-existent local variable
    local.get $nonexistent_local
  )
)
