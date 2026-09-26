// Serveur local : `POST /event` sur 127.0.0.1 uniquement, avec jeton.
// Répond avant de traiter : l'émetteur n'attend jamais l'île.

use std::io::Read;
use std::thread;

use tiny_http::{Method, Request, Response, Server};

use crate::contract::{self, Event, MAX_BODY_BYTES};

pub const TOKEN_HEADER: &str = "X-ReversePrompt-Token";

pub fn start<F>(port: u16, token: String, on_event: F) -> Result<(), String>
where
    F: Fn(Event) + Send + 'static,
{
    let server = Server::http(("127.0.0.1", port)).map_err(|e| format!("127.0.0.1:{port} : {e}"))?;
    thread::Builder::new()
        .name("event-server".into())
        .spawn(move || {
            for request in server.incoming_requests() {
                if let Some(event) = handle(request, &token) {
                    on_event(event);
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Répond à la requête et rend l'événement accepté, s'il y en a un.
fn handle(mut request: Request, token: &str) -> Option<Event> {
    let path = request.url().split('?').next().unwrap_or("").to_owned();
    let method = request.method().clone();
    let reply = |request: Request, code: u16, body: &str| {
        let _ = request.respond(Response::from_string(body).with_status_code(code));
    };

    match (method, path.as_str()) {
        (Method::Get, "/health") => {
            reply(request, 200, &format!("reverse-prompt {}", contract::VERSION));
            None
        }
        (Method::Post, "/event") => {
            let given = request
                .headers()
                .iter()
                .find(|h| h.field.equiv(TOKEN_HEADER))
                .map(|h| h.value.as_str().to_owned());
            if !given.is_some_and(|g| same(g.as_bytes(), token.as_bytes())) {
                reply(request, 401, "jeton absent ou faux");
                return None;
            }
            if request.body_length().is_some_and(|n| n > MAX_BODY_BYTES) {
                reply(request, 413, "corps trop gros");
                return None;
            }
            let mut body = Vec::new();
            let read = request.as_reader().take(MAX_BODY_BYTES as u64 + 1).read_to_end(&mut body);
            if read.is_err() {
                reply(request, 400, "corps illisible");
                return None;
            }
            if body.len() > MAX_BODY_BYTES {
                reply(request, 413, "corps trop gros");
                return None;
            }
            match contract::parse(&body) {
                Ok(event) => {
                    let _ = request.respond(Response::empty(204));
                    Some(event)
                }
                Err(e) => {
                    reply(request, 400, &e);
                    None
                }
            }
        }
        // Pas d'en-têtes CORS : une page web ne peut pas envoyer l'en-tête du jeton.
        (_, "/event" | "/health") => {
            reply(request, 405, "méthode non gérée");
            None
        }
        _ => {
            reply(request, 404, "introuvable");
            None
        }
    }
}

// Comparaison en temps constant.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;
    use std::sync::mpsc;
    use std::time::Duration;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn status(port: u16, raw: &str) -> u16 {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(raw.as_bytes()).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        line.split_whitespace().nth(1).unwrap().parse().unwrap()
    }

    fn post(port: u16, token: &str, body: &str) -> u16 {
        status(
            port,
            &format!(
                "POST /event HTTP/1.1\r\nHost: x\r\nConnection: close\r\n{TOKEN_HEADER}: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            ),
        )
    }

    #[test]
    fn http_contract() {
        let port = 47700 + (std::process::id() % 200) as u16;
        let (tx, rx) = mpsc::channel();
        start(port, TOKEN.into(), move |e| tx.send(e).unwrap()).unwrap();
        let good = r#"{"v":1,"source":"t","kind":"done","session":"s"}"#;

        assert_eq!(status(port, "GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), 200);
        assert_eq!(post(port, TOKEN, good), 204);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap().session, "s");
        assert_eq!(post(port, "faux", good), 401);
        assert_eq!(post(port, TOKEN, "{"), 400);
        assert_eq!(post(port, TOKEN, &"x".repeat(MAX_BODY_BYTES + 1)), 413);
        assert_eq!(status(port, "GET /event HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), 405);
        assert_eq!(status(port, "OPTIONS /event HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), 405);
        assert_eq!(status(port, "GET /nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), 404);
        assert!(rx.try_recv().is_err());
    }
}
