# API Design Examples

## DTO/Entity Separation Example

```java
// ✅ Good: Separate DTO and Entity
@RestController
@RequestMapping("/api/tasks")
public class TaskController {
    @PostMapping
    public ResponseEntity<TaskResponse> createTask(@Valid @RequestBody CreateTaskRequest request) {
        Task task = taskService.createTask(request);
        return ResponseEntity
            .created(URI.create("/api/tasks/" + task.getId()))
            .body(TaskResponse.from(task));
    }
}

// ❌ Bad: Exposing entity directly
@PostMapping
public ResponseEntity<Task> createTask(@RequestBody Task task) {  // Leaks JPA internals
    return ResponseEntity.ok(taskRepository.save(task));
}
```

## Global Exception Handler Example

```java
// Standardized error response
public record ErrorResponse(
    String code,        // Machine-readable: "VALIDATION_ERROR"
    String message,     // Human-readable: "Email is required"
    Object details      // Additional context (e.g., field errors)
) {}

// Global exception handler
@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidationError(
        MethodArgumentNotValidException ex
    ) {
        Map<String, String> fieldErrors = ex.getBindingResult()
            .getFieldErrors()
            .stream()
            .collect(Collectors.toMap(
                FieldError::getField,
                error -> error.getDefaultMessage() != null ? error.getDefaultMessage() : ""
            ));

        ErrorResponse error = new ErrorResponse(
            "VALIDATION_ERROR",
            "Invalid request data",
            fieldErrors
        );
        return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY).body(error);
    }

    @ExceptionHandler(TaskNotFoundException.class)
    public ResponseEntity<ErrorResponse> handleNotFound(TaskNotFoundException ex) {
        ErrorResponse error = new ErrorResponse(
            "NOT_FOUND",
            ex.getMessage(),
            null
        );
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(error);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnexpected(Exception ex) {
        // Never expose internal details in 500 errors
        ErrorResponse error = new ErrorResponse(
            "INTERNAL_ERROR",
            "An unexpected error occurred",
            null
        );
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(error);
    }
}
```
