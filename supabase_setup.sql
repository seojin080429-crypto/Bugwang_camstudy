-- ============================================================
-- 캠스터디 앱 - Supabase 테이블 생성 SQL
-- Supabase 대시보드 > 왼쪽 메뉴 "SQL Editor" 에 붙여넣고 RUN 하세요.
-- ============================================================

-- 1) 사용자(계정) 테이블
create table if not exists users (
  student_id    text primary key,        -- 학번 (예: 30101)
  password_hash text not null,
  nickname      text,
  must_change   boolean default true,    -- 초기비번이면 true
  created_at    timestamptz default now()
);

-- 2) 질문 테이블
create table if not exists questions (
  id          bigint generated always as identity primary key,
  student_id  text not null,
  subject     text not null,             -- 과목
  body        text,                      -- 질문 내용(선택)
  image_path  text,                      -- 사진 공개 URL(선택)
  created_at  timestamptz default now()
);

-- 3) 답변 테이블
create table if not exists answers (
  id           bigint generated always as identity primary key,
  question_id  bigint not null references questions(id) on delete cascade,
  student_id   text not null,
  body         text not null,
  created_at   timestamptz default now()
);

-- 끝. (서버는 service_role 키로 접속하므로 RLS 추가 설정 없이 동작합니다.)
