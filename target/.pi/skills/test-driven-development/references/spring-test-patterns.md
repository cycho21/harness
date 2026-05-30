# Spring Boot Test Patterns

## Unit Tests (Small)

Use Mockito for pure business logic:

```java
@ExtendWith(MockitoExtension.class)
class TaskServiceTest {
    @Mock
    private TaskRepository taskRepository;

    @InjectMocks
    private TaskService taskService;

    @Test
    void createTask_savesAndReturns() {
        // Arrange
        CreateTaskRequest request = new CreateTaskRequest("Test");
        Task savedTask = Task.builder().id(1L).title("Test").build();
        when(taskRepository.save(any(Task.class))).thenReturn(savedTask);

        // Act
        Task result = taskService.createTask(request);

        // Assert
        assertThat(result.getId()).isEqualTo(1L);
        verify(taskRepository).save(any(Task.class));
    }
}
```

## Slice Tests (Medium)

Test specific layers with Spring Test slices:

```java
// Controller layer test (no service layer loaded)
@WebMvcTest(TaskController.class)
class TaskControllerTest {
    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private TaskService taskService;

    @Test
    void createTask_returns201() throws Exception {
        Task task = Task.builder().id(1L).title("Test").build();
        when(taskService.createTask(any())).thenReturn(task);

        mockMvc.perform(post("/api/tasks")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"title\":\"Test\"}"))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.id").value(1))
            .andExpect(jsonPath("$.title").value("Test"));
    }
}

// Repository layer test (no service, no controller)
@DataJpaTest
class TaskRepositoryTest {
    @Autowired
    private TaskRepository taskRepository;

    @Test
    void findByStatus_returnsMatchingTasks() {
        Task task = taskRepository.save(
            Task.builder().title("Test").status(TaskStatus.PENDING).build()
        );

        List<Task> pending = taskRepository.findByStatus(TaskStatus.PENDING);

        assertThat(pending).hasSize(1);
        assertThat(pending.get(0).getId()).isEqualTo(task.getId());
    }
}
```

## Integration Tests (Large)

Full Spring Boot context with real database:

```java
@SpringBootTest
@AutoConfigureMockMvc
class TaskIntegrationTest {
    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private TaskRepository taskRepository;

    @BeforeEach
    void setUp() {
        taskRepository.deleteAll();
    }

    @Test
    void createTask_persistsToDatabase() throws Exception {
        mockMvc.perform(post("/api/tasks")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"title\":\"Integration Test\"}"))
            .andExpect(status().isCreated());

        List<Task> tasks = taskRepository.findAll();
        assertThat(tasks).hasSize(1);
        assertThat(tasks.get(0).getTitle()).isEqualTo("Integration Test");
    }
}
```
