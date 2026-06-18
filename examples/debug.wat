(module
  ;; Nested control flow example for debugging
  (func $nested_demo (export "nested_demo") (param $n i32) (result i32)
    (local $i i32)
    (local $sum i32)
    (local $temp i32)

    ;; Initialize sum to 0
    i32.const 0
    local.set $sum

    ;; Initialize i to 0
    i32.const 0
    local.set $i

    ;; Outer block for early exit
    block $outer
      ;; Loop to iterate from 0 to n
      loop $main_loop
        ;; Check if i >= n, if so exit outer block
        local.get $i
        local.get $n
        i32.ge_s
        br_if $outer

        ;; Nested if-else block
        block $inner
          local.get $i
          i32.const 2
          i32.rem_s
          i32.const 0
          i32.eq
          if $check_even (result i32)
            ;; Even number: add i * 2
            local.get $i
            i32.const 2
            i32.mul
          else
            ;; Odd number: add i * 3 + 1
            local.get $i
            i32.const 3
            i32.mul
            i32.const 1
            i32.add
          end

          ;; Store to temp and add to sum
          local.tee $temp
          local.get $sum
          i32.add
          local.set $sum

          ;; Nested loop for extra computation
          loop $inner_loop
            local.get $temp
            i32.const 1
            i32.gt_s
            if
              local.get $temp
              i32.const 1
              i32.sub
              local.set $temp

              local.get $sum
              local.get $temp
              i32.add
              local.set $sum

              br $inner_loop
            end
          end
        end

        ;; Increment i
        local.get $i
        i32.const 1
        i32.add
        local.set $i

        br $main_loop
      end
    end

    local.get $sum
  )

  ;; Function to test error cases - will be used for error location testing
  (func $error_demo (export "error_demo") (param $a i32) (param $b i32) (result i32)
    local.get $a
    local.get $b
    i32.add
  )
)
