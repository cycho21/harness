# Spring Boot REST Patterns

## Resource Design

```java
@RestController
@RequestMapping("/api/tasks")
@RequiredArgsConstructor
public class TaskController {
    private final TaskService taskService;

    // GET /api/tasks → List (with filtering, pagination)
    @GetMapping
    public ResponseEntity<Page<TaskResponse>> listTasks(
        @RequestParam(required = false) TaskStatus status,
        Pageable pageable
    ) {
        Page<Task> tasks = taskService.listTasks(status, pageable);
        Page<TaskResponse> response = tasks.map(TaskResponse::from);
        return ResponseEntity.ok(response);
    }

    // POST /api/tasks → Create
    @PostMapping
    public ResponseEntity<TaskResponse> createTask(
        @Valid @RequestBody CreateTaskRequest request
    ) {
        Task task = taskService.createTask(request);
        return ResponseEntity
            .created(URI.create("/api/tasks/" + task.getId()))
            .body(TaskResponse::from(task));
    }

    // GET /api/tasks/:id → Get single
    @GetMapping("/{id}")
    public ResponseEntity<TaskResponse> getTask(@PathVariable Long id) {
        Task task = taskService.getTask(id);
        return ResponseEntity.ok(TaskResponse.from(task));
    }

    // PATCH /api/tasks/:id → Partial update
    @PatchMapping("/{id}")
    public ResponseEntity<TaskResponse> updateTask(
        @PathVariable Long id,
        @Valid @RequestBody UpdateTaskRequest request
    ) {
        Task task = taskService.updateTask(id, request);
        return ResponseEntity.ok(TaskResponse.from(task));
    }

    // DELETE /api/tasks/:id → Delete
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteTask(@PathVariable Long id) {
        taskService.deleteTask(id);
        return ResponseEntity.noContent().build();
    }
}
```

## Sub-resources

```java
// GET /api/tasks/:taskId/comments → List comments for a task
@GetMapping("/{taskId}/comments")
public ResponseEntity<List<CommentResponse>> listComments(@PathVariable Long taskId) {
    List<Comment> comments = commentService.listByTaskId(taskId);
    return ResponseEntity.ok(comments.stream().map(CommentResponse::from).toList());
}

// POST /api/tasks/:taskId/comments → Add a comment
@PostMapping("/{taskId}/comments")
public ResponseEntity<CommentResponse> addComment(
    @PathVariable Long taskId,
    @Valid @RequestBody CreateCommentRequest request
) {
    Comment comment = commentService.create(taskId, request);
    return ResponseEntity
        .created(URI.create("/api/tasks/" + taskId + "/comments/" + comment.getId()))
        .body(CommentResponse.from(comment));
}
```

## Pagination

Use Spring Data's `Pageable` and `Page`:

```java
// Request: GET /api/tasks?page=0&size=20&sort=createdAt,desc
@GetMapping
public ResponseEntity<Page<TaskResponse>> listTasks(Pageable pageable) {
    Page<Task> tasks = taskRepository.findAll(pageable);
    return ResponseEntity.ok(tasks.map(TaskResponse::from));
}

// Response (Spring Data auto-generates)
{
  "content": [...],
  "pageable": { "pageNumber": 0, "pageSize": 20, "sort": { ... } },
  "totalElements": 142,
  "totalPages": 8,
  "last": false,
  "number": 0,
  "size": 20,
  "first": true,
  "numberOfElements": 20
}
```

## Filtering

Use `@RequestParam` for filters:

```java
@GetMapping
public ResponseEntity<Page<TaskResponse>> listTasks(
    @RequestParam(required = false) TaskStatus status,
    @RequestParam(required = false) String assignee,
    @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate createdAfter,
    Pageable pageable
) {
    Page<Task> tasks = taskService.search(status, assignee, createdAfter, pageable);
    return ResponseEntity.ok(tasks.map(TaskResponse::from));
}
```

## Partial Updates (PATCH)

Accept partial objects — only update provided fields:

```java
public record UpdateTaskRequest(
    @Size(max = 200) String title,      // Optional — only updates if provided
    String description,                   // Optional
    TaskStatus status                     // Optional
) {}

@Service
public class TaskService {
    public Task updateTask(Long id, UpdateTaskRequest request) {
        Task task = taskRepository.findById(id)
            .orElseThrow(() -> new TaskNotFoundException(id));

        // Only update non-null fields
        if (request.title() != null) {
            task.setTitle(request.title());
        }
        if (request.description() != null) {
            task.setDescription(request.description());
        }
        if (request.status() != null) {
            task.setStatus(request.status());
        }

        return taskRepository.save(task);
    }
}
```
