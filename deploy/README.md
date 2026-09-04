# hnd 운영 배포

권장 구성은 Docker Compose가 hnd server를 `127.0.0.1:8787`에만 열고, 같은
호스트의 nginx가 운영 domain에서 HTTPS를 종료하는 방식입니다.

```text
client ── https://hnd.example.com ──> host nginx ──> 127.0.0.1:8787
                                                    └─ hnd server + /data/
                                                       ├─ hnd.sqlite
                                                       └─ server-vault.key
```

`hnd.sqlite`와 `server-vault.key`는 한 쌍의 복구 자산입니다. 둘 중 하나만
백업하거나 서로 다른 시점의 파일을 조합하면 계정 보관함을 열 수 없습니다.
`/data` 전체를 일관된 시점에 백업하고 별도 보안 저장소에 보관하세요.

## 적용 순서

1. 운영 domain의 DNS와 TLS 인증서를 준비합니다.
2. 서버를 시작하고 loopback health endpoint를 확인합니다.

   ```sh
   # 최초 1회만 복사하고 기존 .env는 보존
   [ -e .env ] || cp .env.example .env
   # host nginx를 쓸 때 HND_BIND_ADDRESS=127.0.0.1 유지
   HND_RELEASE_SEQUENCE=1 \
   HND_RELEASE_PRIVATE_KEY_FILE=/secure/outside-the-repository/signing-key.pem \
     node scripts/build-connector-release.mjs
   npm test
   docker compose up -d --build
   docker compose ps
   curl --fail http://127.0.0.1:8787/healthz
   ```

   `.env`에서 `HND_PUBLIC_ORIGIN`과 `HND_WEBAUTHN_RP_ID`를 실제 HTTPS 주소로
   바꾸고, `HND_PORT`, `HND_SERVER_MAX_REVISIONS`, `HND_IMAGE`도 필요에 따라
   조정합니다. `HND_PORT`를 바꾸면 nginx `proxy_pass`의 port도 맞춰야 합니다.

3. [`nginx/hnd.conf.example`](nginx/hnd.conf.example)을 호스트 nginx 설정으로
   복사하고 domain과 인증서 경로를 수정합니다.

   ```sh
   sudo install -m 0644 deploy/nginx/hnd.conf.example \
     /etc/nginx/sites-available/hnd.conf
   sudoedit /etc/nginx/sites-available/hnd.conf
   sudo ln -s /etc/nginx/sites-available/hnd.conf \
     /etc/nginx/sites-enabled/hnd.conf
   sudo nginx -t
   sudo systemctl reload nginx
   ```

4. 외부 HTTPS endpoint와 최초 설치용 공개 npm package를 확인합니다.

   ```sh
   curl --fail --output /dev/null https://hnd.example.com/
   curl --fail https://hnd.example.com/healthz
   npm view '@lch-1/hnd@0.2.2' version
   ```

5. 브라우저에서 domain을 열고 첫 소유자를 설정합니다. 계정이 없을 때는 로그인
   대신 초기 설정 창이 나타나며, 서버 명령이나 시작 코드 없이 계정 이름부터
   진행합니다. 패스키, 복구 코드, 계정 보관함과 선택적인 PC 연결을 차례로
   완료하면 같은 주소가 패스키 로그인 창으로 바뀝니다.

   빈 서버에서는 먼저 등록을 완료한 방문자가 소유자가 됩니다. 공개 접근을 열기
   전에 설정을 끝내거나, 설정하는 동안 nginx에서 관리자 IP만 허용하세요.

nginx 예시는 `/` 아래 웹, sync API와 인증된 connector release 경로를 그대로
proxy합니다. `8787`은 공인 interface에 노출하지 말고 외부 방화벽에서도 80/443만
허용합니다. 각 PC는 공개 npm package로 launcher를 한 번 설치하고, 이후 runtime은
서버 image에 포함된 Ed25519 서명 release로 자동 갱신합니다. release를 바꿀 때마다
이전보다 큰 `HND_RELEASE_SEQUENCE`로 bundle을 다시 만든 뒤 image를 교체하며,
서명 개인키는 저장소나 Docker image에 넣지 않습니다.

클라이언트 설치, HND 계정 연결, 자동 sync 장애 처리, backup과 upgrade 절차는
[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)를 참고하세요.
