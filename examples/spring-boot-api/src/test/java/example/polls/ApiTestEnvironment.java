package example.polls;

import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;

import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.utility.MountableFile;

/** Everything the cases in PollsApiTest need besides the app: database, outbound stub, reset, DB diff, concurrency. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
abstract class ApiTestEnvironment {
  static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17-alpine")
      .withCopyFileToContainer(MountableFile.forHostPath("../migrations/20260929000000_init.sql"), "/docker-entrypoint-initdb.d/init.sql");

  static {
    POSTGRES.start();
  }

  // Not WireMock's default: the app's JDK HttpClient offers an h2c upgrade and the POST dies with RST_STREAM.
  @RegisterExtension
  static WireMockExtension slack = WireMockExtension.newInstance().options(wireMockConfig().dynamicPort().http2PlainDisabled(true)).build();

  @DynamicPropertySource
  static void properties(DynamicPropertyRegistry registry) {
    registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
    registry.add("spring.datasource.username", POSTGRES::getUsername);
    registry.add("spring.datasource.password", POSTGRES::getPassword);
    registry.add("slack.webhook-url", () -> slack.baseUrl() + "/hook");
  }

  @LocalServerPort int port;
  @Autowired JdbcTemplate jdbc;

  /** Not a template database or a restart: TRUNCATE keeps the app's connection pool alive. */
  @BeforeEach
  void resetDatabase() throws IOException {
    jdbc.execute("TRUNCATE polls, votes RESTART IDENTITY CASCADE");
    jdbc.execute(Files.readString(Path.of("../seed.sql")));
  }

  String url(String path) {
    return "http://127.0.0.1:" + port + path;
  }

  /** Rows of every table by id, for diffing before and after a request. */
  Map<String, Map<Object, Map<String, Object>>> snapshot() {
    var out = new LinkedHashMap<String, Map<Object, Map<String, Object>>>();
    for (String table : List.of("polls", "votes")) {
      var rows = new LinkedHashMap<Object, Map<String, Object>>();
      for (var row : jdbc.queryForList("SELECT * FROM " + table + " ORDER BY id")) rows.put(row.get("id"), row);
      out.put(table, rows);
    }
    return out;
  }

  record Changes(Map<String, List<Map<String, Object>>> inserted, Map<String, List<Map<String, Object>>> deleted, Map<String, List<Map<String, Object>>> updated) {
    List<String> tables() {
      var all = new ArrayList<String>();
      for (var m : List.of(inserted, deleted, updated)) m.forEach((t, rows) -> { if (!rows.isEmpty() && !all.contains(t)) all.add(t); });
      return all;
    }
  }

  static Changes diff(Map<String, Map<Object, Map<String, Object>>> before, Map<String, Map<Object, Map<String, Object>>> after) {
    var ins = new LinkedHashMap<String, List<Map<String, Object>>>();
    var del = new LinkedHashMap<String, List<Map<String, Object>>>();
    var upd = new LinkedHashMap<String, List<Map<String, Object>>>();
    for (String table : after.keySet()) {
      ins.put(table, new ArrayList<>());
      del.put(table, new ArrayList<>());
      upd.put(table, new ArrayList<>());
      after.get(table).forEach((id, row) -> {
        var old = before.get(table).get(id);
        if (old == null) ins.get(table).add(row);
        else if (!old.equals(row)) upd.get(table).add(row);
      });
      before.get(table).forEach((id, row) -> { if (!after.get(table).containsKey(id)) del.get(table).add(row); });
    }
    return new Changes(ins, del, upd);
  }

  /** All tasks start together once every thread is ready. */
  <T> List<T> concurrently(int n, Callable<T> task) throws Exception {
    ExecutorService pool = Executors.newFixedThreadPool(n);
    try {
      var ready = new CountDownLatch(n);
      var go = new CountDownLatch(1);
      var futures = new ArrayList<Future<T>>();
      for (int i = 0; i < n; i++) {
        futures.add(pool.submit(() -> {
          ready.countDown();
          go.await();
          return task.call();
        }));
      }
      ready.await();
      go.countDown();
      var results = new ArrayList<T>();
      for (var f : futures) results.add(f.get());
      return results;
    } finally {
      pool.shutdown();
    }
  }
}
