package example.polls;

import static com.github.tomakehurst.wiremock.client.WireMock.equalToJson;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.assertj.core.api.Assertions.assertThat;

import com.github.tomakehurst.wiremock.http.Fault;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Cases C1-C9 of examples/comparison/README.md. */
class PollsApiTest extends ApiTestEnvironment {
  private final HttpClient client = HttpClient.newHttpClient();

  private HttpResponse<String> send(String method, String path, String json) throws Exception {
    var builder = HttpRequest.newBuilder(URI.create(url(path)));
    var body = json == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8);
    if (json != null) builder.header("content-type", "application/json");
    return client.send(builder.method(method, body).build(), HttpResponse.BodyHandlers.ofString());
  }

  @Test
  void c1_creating_a_poll_stores_it_and_notifies_slack_once() throws Exception {
    slack.stubFor(post("/hook").willReturn(aResponse().withStatus(200).withBody("ok")));
    var before = snapshot();

    var res = send("POST", "/polls", "{\"title\":\"犬か猫か\",\"a\":\"犬\",\"b\":\"猫\"}");

    assertThat(res.statusCode()).isEqualTo(201);
    var changes = diff(before, snapshot());
    assertThat(changes.tables()).containsExactly("polls");
    assertThat(changes.inserted().get("polls")).hasSize(1);
    assertThat(changes.inserted().get("polls").get(0)).containsEntry("title", "犬か猫か").containsEntry("option_a", "犬").containsEntry("option_b", "猫");
    slack.verify(1, postRequestedFor(urlEqualTo("/hook")).withRequestBody(equalToJson("{\"text\":\"新しい投票: 犬か猫か（犬 vs 猫）\"}")));
  }

  @Test
  void c2_a_failing_notification_leaves_no_poll_behind() throws Exception {
    slack.stubFor(post("/hook").willReturn(aResponse().withStatus(500)));
    var before = snapshot();

    assertThat(send("POST", "/polls", "{\"title\":\"山か海か\",\"a\":\"山\",\"b\":\"海\"}").statusCode()).isEqualTo(502);

    assertThat(diff(before, snapshot()).tables()).isEmpty();
    slack.verify(1, postRequestedFor(urlEqualTo("/hook")));
  }

  @Test
  void c3_a_dropped_connection_to_slack_leaves_no_poll_behind() throws Exception {
    slack.stubFor(post("/hook").willReturn(aResponse().withFault(Fault.CONNECTION_RESET_BY_PEER)));
    var before = snapshot();

    assertThat(send("POST", "/polls", "{\"title\":\"夏か冬か\",\"a\":\"夏\",\"b\":\"冬\"}").statusCode()).isEqualTo(502);

    assertThat(diff(before, snapshot()).tables()).isEmpty();
  }

  @Test
  void c4_a_poll_without_options_is_a_400_and_nothing_happens() throws Exception {
    var before = snapshot();

    assertThat(send("POST", "/polls", "{\"title\":\"選択肢なし\"}").statusCode()).isEqualTo(400);

    assertThat(diff(before, snapshot()).tables()).isEmpty();
    slack.verify(0, postRequestedFor(urlEqualTo("/hook")));
  }

  @Test
  void c5_voting_a_and_b_stores_one_vote_each() throws Exception {
    var before = snapshot();

    assertThat(send("POST", "/polls/1/votes", "{\"choice\":\"a\"}").statusCode()).isEqualTo(204);
    assertThat(send("POST", "/polls/1/votes", "{\"choice\":\"b\"}").statusCode()).isEqualTo(204);

    var changes = diff(before, snapshot());
    assertThat(changes.tables()).containsExactly("votes");
    assertThat(changes.inserted().get("votes")).extracting(r -> r.get("choice")).containsExactlyInAnyOrder("a", "b");
  }

  @Test
  void c6_an_invalid_choice_is_a_400_and_an_unknown_poll_a_404() throws Exception {
    var before = snapshot();

    assertThat(send("POST", "/polls/1/votes", "{\"choice\":\"x\"}").statusCode()).isEqualTo(400);
    assertThat(send("POST", "/polls/999/votes", "{\"choice\":\"a\"}").statusCode()).isEqualTo(404);

    assertThat(diff(before, snapshot()).tables()).isEmpty();
  }

  @Test
  void c7_the_aggregate_counts_each_choice() throws Exception {
    jdbc.update("INSERT INTO votes (poll_id, choice) VALUES (1, 'a'), (1, 'a'), (1, 'b')");

    var res = send("GET", "/polls/1", null);

    assertThat(res.statusCode()).isEqualTo(200);
    var json = new com.fasterxml.jackson.databind.ObjectMapper().readValue(res.body(), Map.class);
    assertThat(json).isEqualTo(Map.of("id", 1, "title", "朝食は？", "options", Map.of("a", "ごはん", "b", "パン"), "votes", Map.of("a", 2, "b", 1)));
  }

  @Test
  void c8_ten_simultaneous_votes_are_all_stored() throws Exception {
    var statuses = concurrently(10, () -> send("POST", "/polls/1/votes", "{\"choice\":\"a\"}").statusCode());

    assertThat(statuses).containsOnly(204);
    assertThat(jdbc.queryForObject("SELECT count(*) FROM votes WHERE poll_id = 1", Integer.class)).isEqualTo(10);
  }

  @Test
  void c9_every_case_starts_from_the_seed() {
    assertThat(jdbc.queryForObject("SELECT count(*) FROM votes", Integer.class)).isZero();
    assertThat(jdbc.queryForList("SELECT id, title FROM polls")).isEqualTo(List.of(Map.of("id", 1L, "title", "朝食は？")));
  }
}
