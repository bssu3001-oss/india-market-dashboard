"""시장데이터.json만 갱신 (카톡은 절대 보내지 않음).

대시보드의 예비 데이터용. 중계 서버가 잠깐 안 될 때 화면이 "--" 대신 이 값을 보여줌.
알림체크.py의 데이터 수집 코드를 그대로 쓰고, 카톡 전송·상태 저장만 꺼서 실행한다.
"""
import importlib
import os

# 알림체크.py가 "카톡 키 없음"으로 중간에 끝나지 않도록 가짜 값 (실제 전송은 아래에서 막음)
os.environ["KAKAO_REST_API_KEY"] = "data-only"
os.environ["KAKAO_REFRESH_TOKEN"] = "data-only"

a = importlib.import_module("알림체크")

def _noop(*args, **kwargs):
    return False

for name in ("kakao_send", "send_kakao", "save_state"):
    if hasattr(a, name):
        setattr(a, name, _noop)
for name in ("kakao_get_access_token", "kakao_refresh_access_token"):
    if hasattr(a, name):
        setattr(a, name, lambda *x, **k: "data-only")
if hasattr(a, "get_slot"):  # 브라질: 알림 시간대 아니면 종료하는 부분 우회
    a.get_slot = lambda: "data-only"

a.main()
