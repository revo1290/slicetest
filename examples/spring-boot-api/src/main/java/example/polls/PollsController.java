package example.polls;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;

// One controller and plain JDBC, not JPA or layers: the shared scenarios exercise the API, not Spring style.
@RestController
public class PollsController {
  private final JdbcTemplate jdbc;
  private final TransactionTemplate tx;
  private final RestClient slack = RestClient.create();
  private final String slackUrl;

  public PollsController(JdbcTemplate jdbc, TransactionTemplate tx, @Value("${slack.webhook-url}") String slackUrl) {
    this.jdbc = jdbc;
    this.tx = tx;
    this.slackUrl = slackUrl;
  }

  @GetMapping("/health")
  Map<String, Object> health() {
    return Map.of("ok", true);
  }

  @PostMapping("/polls")
  ResponseEntity<Map<String, Object>> create(@RequestBody(required = false) Map<String, Object> body) {
    String title = text(body, "title"), a = text(body, "a"), b = text(body, "b");
    if (title == null || a == null || b == null) return error(HttpStatus.BAD_REQUEST, "title, a and b are required");
    try {
      // Not notify-after-commit: a failed notification has to roll the poll back.
      Long id = tx.execute(status -> {
        Long created = jdbc.queryForObject("INSERT INTO polls (title, option_a, option_b) VALUES (?, ?, ?) RETURNING id", Long.class, title, a, b);
        slack.post().uri(slackUrl).contentType(MediaType.APPLICATION_JSON)
            .body(Map.of("text", "新しい投票: " + title + "（" + a + " vs " + b + "）"))
            .retrieve().toBodilessEntity();
        return created;
      });
      return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("id", id));
    } catch (RuntimeException e) {
      // Not e.getMessage(): RestClient puts the request URL in it, and a real Slack webhook URL is a secret.
      System.err.println("create poll failed: " + e.getClass().getSimpleName());
      return error(HttpStatus.BAD_GATEWAY, "notification failed");
    }
  }

  @GetMapping("/polls/{id:\\d+}")
  ResponseEntity<Map<String, Object>> get(@PathVariable long id) {
    var rows = jdbc.queryForList(
        """
        SELECT p.id, p.title, p.option_a, p.option_b,
               count(v.*) FILTER (WHERE v.choice = 'a') AS a_votes,
               count(v.*) FILTER (WHERE v.choice = 'b') AS b_votes
          FROM polls p LEFT JOIN votes v ON v.poll_id = p.id
         WHERE p.id = ? GROUP BY p.id""",
        id);
    if (rows.isEmpty()) return error(HttpStatus.NOT_FOUND, "not found");
    var p = rows.get(0);
    var out = new LinkedHashMap<String, Object>();
    out.put("id", p.get("id"));
    out.put("title", p.get("title"));
    out.put("options", Map.of("a", p.get("option_a"), "b", p.get("option_b")));
    out.put("votes", Map.of("a", p.get("a_votes"), "b", p.get("b_votes")));
    return ResponseEntity.ok(out);
  }

  @PostMapping("/polls/{id:\\d+}/votes")
  ResponseEntity<Map<String, Object>> vote(@PathVariable long id, @RequestBody(required = false) Map<String, Object> body) {
    String choice = text(body, "choice");
    if (!"a".equals(choice) && !"b".equals(choice)) return error(HttpStatus.BAD_REQUEST, "choice must be a or b");
    int rows = jdbc.update("INSERT INTO votes (poll_id, choice) SELECT id, ? FROM polls WHERE id = ?", choice, id);
    return rows > 0 ? ResponseEntity.noContent().build() : error(HttpStatus.NOT_FOUND, "not found");
  }

  private static String text(Map<String, Object> body, String key) {
    Object v = body == null ? null : body.get(key);
    return v instanceof String s && !s.isEmpty() ? s : null;
  }

  private static ResponseEntity<Map<String, Object>> error(HttpStatus status, String message) {
    return ResponseEntity.status(status).body(Map.of("error", message));
  }
}
