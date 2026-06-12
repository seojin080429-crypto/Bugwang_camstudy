# 📚 우리반 캠스터디 — 설치 & 배포 가이드

학번으로 로그인해 친구들과 화상 캠스터디(마이크 X·채팅 O·카메라 선택·화면 가리기)를 하고,
질문 게시판에 사진을 올려 답변받는 웹앱입니다.
데이터(계정·질문·답변·사진)는 **Supabase**에 영구 저장되어 서버가 꺼져도 사라지지 않습니다.

---

## 전체 그림
- **Render** : 앱(서버)을 항상 켜진 상태로 인터넷에 띄워줌 (무료)
- **Supabase** : 계정·질문·답변(DB) + 사진(Storage)을 영구 저장 (무료)
- 둘 다 무료, 신용카드 필요 없음.

설치 순서: ① Supabase 준비 → ② GitHub에 코드 올리기 → ③ Render에 배포

---

## ① Supabase 준비

1. https://supabase.com 접속 → "Start your project" → GitHub 계정 등으로 가입/로그인.
2. New Project 클릭.
   - Name: 아무거나 (예: camstudy)
   - Database Password: 적당히 정하고 메모해 두기
   - Region: Northeast Asia (Seoul) 추천
   - 생성까지 1~2분.
3. 테이블 만들기
   - 왼쪽 메뉴 SQL Editor 클릭 → New query.
   - 같이 받은 supabase_setup.sql 내용을 전부 복사해 붙여넣고 Run.
   - "Success" 나오면 됨.
4. 사진 저장소(버킷) 만들기
   - 왼쪽 메뉴 Storage → New bucket.
   - Name: 정확히 question-photos 로 입력 (코드와 이름이 같아야 함)
   - Public bucket 옵션 켜기(ON) → Create.
5. 연결 키 2개 복사 (다음 단계에서 Render에 넣음)
   - 왼쪽 메뉴 Project Settings(톱니바퀴) → API.
   - Project URL → SUPABASE_URL (예: https://abcd1234.supabase.co)
   - Project API keys 중 service_role 키 → SUPABASE_SERVICE_KEY
     - ⚠️ service_role 키는 비밀번호처럼 다룰 것. 공유 금지, 코드에 직접 적지 말 것.

---

## ② GitHub에 코드 올리기

1. https://github.com 가입/로그인.
2. 오른쪽 위 + → New repository.
   - Repository name: camstudy
   - Private 권장
   - Create repository.
3. 코드 업로드(드래그가 가장 쉬움):
   - repo 페이지에서 "uploading an existing file" 링크 클릭.
   - 파일 올리기: server.js, package.json, supabase_setup.sql, README.md, 그리고 public 폴더.
   - ⚠️ node_modules 폴더는 올리지 마세요. .gitignore가 제외합니다.
   - public/index.html 위치 그대로 유지.
   - Commit changes.

---

## ③ Render에 배포

1. https://render.com → GitHub 계정으로 로그인.
2. New + → Web Service.
3. camstudy 저장소 연결(Connect).
4. 설정값:
   - Name: 아무거나 (이게 주소가 됨)
   - Branch: main
   - Build Command: npm install
   - Start Command: npm start
   - Instance Type: Free
5. Environment(환경변수) 3개 추가 (Add Environment Variable):
   - SUPABASE_URL        = ①의 Project URL
   - SUPABASE_SERVICE_KEY = ①의 service_role 키
   - JWT_SECRET          = 아무 긴 랜덤 문자열 (예: my-very-long-random-secret-9f8a7)
6. Create Web Service → 빌드 끝나면 https://....onrender.com 주소 생성.
7. 그 주소 접속 → 학번 30101, 비번 1234 로 로그인 테스트.

친구들에게 그 주소만 알려주면 각자 접속해 같이 캠스터디 가능.

---

## 알아두면 좋은 점

- 첫 접속이 느림(약 30초): 무료 플랜은 한동안 안 쓰면 잠들었다 깨어남. 한 명이 깨우면 그 뒤론 빠름.
- Supabase 일시정지: 7일간 아무도 안 쓰면 멈출 수 있음. 대시보드에서 Restore 버튼으로 재시작. 데이터는 안 사라짐.
- 카메라: HTTPS에서만 동작. Render 주소(https)는 조건 충족.
- 학교 와이파이: WebRTC 화상이 일부 방화벽에서 막힐 수 있음. 그땐 TURN 서버 추가 필요(원하면 안내).
- 계정: 30101~30128은 서버 켜질 때 자동 생성. 비번 변경 내역도 Supabase에 영구 저장.

---

## 로컬(내 컴퓨터)에서 먼저 테스트

1. npm install
2. 환경변수 설정 후 실행. 윈도우(명령 프롬프트) 예:
   set SUPABASE_URL=https://xxxx.supabase.co
   set SUPABASE_SERVICE_KEY=여기에_service_role_키
   set JWT_SECRET=아무거나길게
   npm start
3. 브라우저에서 http://localhost:3000

---

## 파일 구조
camstudy/
├─ server.js              # 서버 (Supabase 연동)
├─ package.json
├─ supabase_setup.sql     # Supabase에 붙여넣을 테이블 생성 SQL
├─ README.md              # 이 문서
├─ .gitignore
└─ public/
   └─ index.html          # 로그인 / 캠스터디 / 질문방 화면
