# JPA Entity Relationship Design

## @OneToMany / @ManyToOne

```java
// Parent (Task)
@Entity
public class Task {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @OneToMany(mappedBy = "task", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<Comment> comments = new ArrayList<>();

    // Helper method to maintain bidirectional sync
    public void addComment(Comment comment) {
        comments.add(comment);
        comment.setTask(this);
    }
}

// Child (Comment)
@Entity
public class Comment {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "task_id", nullable = false)
    private Task task;
}
```

**Best practices:**
- Use `FetchType.LAZY` (default for `@ManyToOne`, `@OneToOne`) to avoid N+1 queries
- Set `cascade` and `orphanRemoval` on the **owning side** (`@OneToMany`)
- Always maintain bidirectional sync with helper methods

## @ManyToMany

```java
@Entity
public class Task {
    @ManyToMany
    @JoinTable(
        name = "task_labels",
        joinColumns = @JoinColumn(name = "task_id"),
        inverseJoinColumns = @JoinColumn(name = "label_id")
    )
    private Set<Label> labels = new HashSet<>();
}

@Entity
public class Label {
    @ManyToMany(mappedBy = "labels")
    private Set<Task> tasks = new HashSet<>();
}
```
