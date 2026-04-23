#!/usr/bin/env python3
"""
大华门禁 SDK 操作脚本（多设备版）
用法：
  access2.py --device-ip IP --device-port PORT --username USER --password PASS <命令> [参数...]

命令列表：
  open [门号]                  # 远程开门，默认门0
  adduser <ID> <姓名>          # 添加人员
  getuser <ID>                 # 查询人员
  deluser <ID>                 # 删除人员
  face <ID> <图片路径> [max_kb] [宽] [高] [质量]   # 下发人脸
  dface <ID>                   # 删除人脸
  log <开始日期> [结束日期]      # 查询日志，格式 2026-04-21
"""

import sys
import argparse
import datetime
import time
import base64
import hashlib
import io
from PIL import Image
import requests
from requests.auth import HTTPDigestAuth

from NetSDK.NetSDK import NetClient
from NetSDK.SDK_Callback import fDisConnect, fHaveReConnect, fMessCallBackEx1, fAnalyzerDataCallBack
from NetSDK.SDK_Struct import *
from NetSDK.SDK_Enum import *
from ctypes import sizeof, cast, POINTER, pointer, byref, c_void_p

METHOD_MAP = {
    1: "刷卡", 2: "密码", 3: "卡+密码", 4: "指纹",
    5: "远程开门", 6: "按钮开门", 16: "人脸识别",
}

# ------------------------------------------------------------
# 全局 SDK 实例（每次操作独立登录，用完注销）
# ------------------------------------------------------------
def login(ip, port, username, password):
    sdk = NetClient()
    sdk.InitEx(fDisConnect(lambda a, b, c, d: None))
    sdk.SetAutoReconnect(fHaveReConnect(lambda a, b, c, d: None))

    stuIn = NET_IN_LOGIN_WITH_HIGHLEVEL_SECURITY()
    stuIn.dwSize = sizeof(NET_IN_LOGIN_WITH_HIGHLEVEL_SECURITY)
    stuIn.szIP = ip.encode()
    stuIn.nPort = port
    stuIn.szUserName = username.encode()
    stuIn.szPassword = password.encode()
    stuIn.emSpecCap = EM_LOGIN_SPAC_CAP_TYPE.TCP
    stuOut = NET_OUT_LOGIN_WITH_HIGHLEVEL_SECURITY()
    stuOut.dwSize = sizeof(NET_OUT_LOGIN_WITH_HIGHLEVEL_SECURITY)

    loginID, _, error_msg = sdk.LoginWithHighLevelSecurity(stuIn, stuOut)
    if loginID == 0:
        print(f"❌ SDK 登录失败: {error_msg}")
        sdk.Cleanup()
        return None, None
    print(f"✅ SDK 登录成功 ({ip}:{port})")
    return sdk, loginID


def logout(sdk, loginID):
    if loginID:
        sdk.Logout(loginID)
    if sdk:
        sdk.Cleanup()


# ------------------------------------------------------------
# 工具函数
# ------------------------------------------------------------
def make_net_time(dt: datetime.datetime) -> NET_TIME:
    t = NET_TIME()
    t.dwYear = dt.year
    t.dwMonth = dt.month
    t.dwDay = dt.day
    t.dwHour = dt.hour
    t.dwMinute = dt.minute
    t.dwSecond = dt.second
    return t


def compress_image(image_path: str, max_size: int = 0, width: int = 0, height: int = 0, quality: int = 0) -> bytes:
    if max_size == 0 and width == 0 and height == 0 and quality == 0:
        with open(image_path, "rb") as f:
            return f.read()
    img = Image.open(image_path).convert("RGB")
    if width > 0 and height > 0:
        img = img.resize((width, height))
    elif width > 0 or height > 0:
        img.thumbnail((width or 9999, height or 9999))
    q = quality if quality > 0 else 85
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=q)
    return buf.getvalue()


# ------------------------------------------------------------
# 门禁操作（使用传入的 SDK 实例）
# ------------------------------------------------------------
def open_door(sdk, loginID, channel: int = 0):
    ctrl = NET_CTRL_ACCESS_OPEN()
    ctrl.dwSize = sizeof(NET_CTRL_ACCESS_OPEN)
    ctrl.nChannelID = channel
    ctrl.szTargetID = None
    ctrl.emOpenDoorType = EM_OPEN_DOOR_TYPE.EM_OPEN_DOOR_TYPE_REMOTE
    ctrl.emOpenDoorDirection = EM_OPEN_DOOR_DIRECTION.EM_OPEN_DOOR_DIRECTION_UNKNOWN
    result = sdk.ControlDevice(loginID, CtrlType.ACCESS_OPEN, ctrl, 5000)
    if result:
        print(f"✅ 远程开门成功 (门{channel})")
    else:
        print(f"❌ 远程开门失败: {sdk.GetLastErrorMessage()}")


def insert_user(sdk, loginID, user_id: str, name: str,
                door_list=None, valid_begin=None, valid_end=None):
    if door_list is None:
        door_list = [0]
    if valid_begin is None:
        valid_begin = datetime.datetime(2000, 1, 1)
    if valid_end is None:
        valid_end = datetime.datetime(2037, 12, 31)

    user = NET_ACCESS_USER_INFO()
    user.szUserID = user_id.encode()
    user.szName = name.encode('utf-8')
    user.emUserType = EM_A_NET_ENUM_USER_TYPE.NET_ENUM_USER_TYPE_NORMAL
    user.nUserStatus = 0
    user.nDoorNum = len(door_list)
    for i, d in enumerate(door_list):
        user.nDoors[i] = d
    user.stuValidBeginTime = make_net_time(valid_begin)
    user.stuValidEndTime = make_net_time(valid_end)

    fail_codes = (C_ENUM * 1)()
    inParam = NET_IN_ACCESS_USER_SERVICE_INSERT()
    inParam.dwSize = sizeof(NET_IN_ACCESS_USER_SERVICE_INSERT)
    inParam.nInfoNum = 1
    inParam.pUserInfo = pointer(user)
    outParam = NET_OUT_ACCESS_USER_SERVICE_INSERT()
    outParam.dwSize = sizeof(NET_OUT_ACCESS_USER_SERVICE_INSERT)
    outParam.nMaxRetNum = 1
    outParam.pFailCode = cast(fail_codes, POINTER(C_ENUM))

    result = sdk.OperateAccessUserService(
        loginID,
        EM_A_NET_EM_ACCESS_CTL_USER_SERVICE.NET_EM_ACCESS_CTL_USER_SERVICE_INSERT,
        inParam, outParam, 5000
    )
    if result:
        print(f"✅ 添加人员成功: {user_id} / {name}")
    else:
        print(f"❌ 添加人员失败: {sdk.GetLastErrorMessage()}")


def get_user(sdk, loginID, user_id: str):
    fail_codes = (C_ENUM * 1)()
    users = (NET_ACCESS_USER_INFO * 1)()
    inParam = NET_IN_ACCESS_USER_SERVICE_GET()
    inParam.dwSize = sizeof(NET_IN_ACCESS_USER_SERVICE_GET)
    inParam.nUserNum = 1
    inParam.szUserID = user_id.encode().ljust(32, b'\x00')
    outParam = NET_OUT_ACCESS_USER_SERVICE_GET()
    outParam.dwSize = sizeof(NET_OUT_ACCESS_USER_SERVICE_GET)
    outParam.nMaxRetNum = 1
    outParam.pUserInfo = cast(users, POINTER(NET_ACCESS_USER_INFO))
    outParam.pFailCode = cast(fail_codes, POINTER(C_ENUM))

    result = sdk.OperateAccessUserService(
        loginID,
        EM_A_NET_EM_ACCESS_CTL_USER_SERVICE.NET_EM_ACCESS_CTL_USER_SERVICE_GET,
        inParam, outParam, 5000
    )
    if result:
        u = users[0]
        name = u.szName.decode('utf-8', errors='ignore')
        status = "正常" if u.nUserStatus == 0 else "冻结"
        doors = [u.nDoors[i] for i in range(u.nDoorNum)]
        b, e = u.stuValidBeginTime, u.stuValidEndTime
        print(f"✅ 查询成功:")
        print(f"   ID    : {user_id}")
        print(f"   姓名  : {name}")
        print(f"   状态  : {status}")
        print(f"   门权限: {doors}")
        print(f"   有效期: {b.dwYear}-{b.dwMonth:02d}-{b.dwDay:02d} "
              f"~ {e.dwYear}-{e.dwMonth:02d}-{e.dwDay:02d}")
    else:
        print(f"❌ 查询失败: {sdk.GetLastErrorMessage()}")


def remove_user(sdk, loginID, user_id: str):
    fail_codes = (C_ENUM * 1)()
    inParam = NET_IN_ACCESS_USER_SERVICE_REMOVE()
    inParam.dwSize = sizeof(NET_IN_ACCESS_USER_SERVICE_REMOVE)
    inParam.nUserNum = 1
    inParam.szUserID = user_id.encode().ljust(32, b'\x00')
    outParam = NET_OUT_ACCESS_USER_SERVICE_REMOVE()
    outParam.dwSize = sizeof(NET_OUT_ACCESS_USER_SERVICE_REMOVE)
    outParam.nMaxRetNum = 1
    outParam.pFailCode = cast(fail_codes, POINTER(C_ENUM))

    result = sdk.OperateAccessUserService(
        loginID,
        EM_A_NET_EM_ACCESS_CTL_USER_SERVICE.NET_EM_ACCESS_CTL_USER_SERVICE_REMOVE,
        inParam, outParam, 5000
    )
    if result:
        print(f"✅ 删除人员成功: {user_id}")
    else:
        print(f"❌ 删除人员失败: {sdk.GetLastErrorMessage()}")


def cgi_post(ip, username, password, action: str, payload: dict):
    url = f"http://{ip}/cgi-bin/FaceInfoManager.cgi?action={action}"
    try:
        r = requests.post(
            url,
            json=payload,
            auth=HTTPDigestAuth(username, password),
            timeout=30
        )
        text = r.text.strip()
        if r.status_code == 200 and (text in ("OK", "ok") or '"result": true' in text.lower() or "success" in text.lower()):
            return True, text or "OK"
        else:
            return False, f"HTTP {r.status_code}: {text}"
    except Exception as e:
        return False, f"请求异常: {e}"


def insert_face(ip, username, password, user_id: str, image_path: str,
                max_kb=0, width=0, height=0, quality=0):
    img_bytes = compress_image(image_path, max_kb, width, height, quality)
    img_b64 = base64.b64encode(img_bytes).decode("utf-8")
    payload = {"UserID": user_id, "Info": {"PhotoData": [img_b64]}}
    success, msg = cgi_post(ip, username, password, "add", payload)
    if success:
        print(f"✅ 人脸下发成功: {user_id}")
    else:
        print(f"❌ 人脸下发失败: {msg}")


def remove_face(ip, username, password, user_id: str):
    payload = {"UserIDList": [user_id]}
    success, msg = cgi_post(ip, username, password, "delete", payload)
    if success:
        print(f"✅ 人脸删除成功: {user_id}")
    else:
        print(f"❌ 人脸删除失败: {msg}")


def query_log(sdk, loginID, start: datetime.datetime, end: datetime.datetime):
    condition = NET_FIND_RECORD_ACCESSCTLCARDREC_CONDITION_EX()
    condition.dwSize = sizeof(NET_FIND_RECORD_ACCESSCTLCARDREC_CONDITION_EX)
    condition.bTimeEnable = True
    condition.stStartTime = make_net_time(start)
    condition.stEndTime = make_net_time(end)
    condition.nOrderNum = 0

    inParam = NET_IN_FIND_RECORD_PARAM()
    inParam.dwSize = sizeof(NET_IN_FIND_RECORD_PARAM)
    inParam.emType = EM_NET_RECORD_TYPE.ACCESSCTLCARDREC_EX
    inParam.pQueryCondition = cast(byref(condition), c_void_p)
    outParam = NET_OUT_FIND_RECORD_PARAM()
    outParam.dwSize = sizeof(NET_OUT_FIND_RECORD_PARAM)

    result = sdk.FindRecord(loginID, inParam, outParam, 5000)
    if not result:
        print(f"❌ FindRecord 失败: {sdk.GetLastErrorMessage()}")
        return

    findHandle = outParam.lFindeHandle
    print(f"✅ 开始查询 {start.date()} ~ {end.date()}")
    total = 0
    BATCH = 20

    while True:
        findIn = NET_IN_FIND_NEXT_RECORD_PARAM()
        findIn.dwSize = sizeof(NET_IN_FIND_NEXT_RECORD_PARAM)
        findIn.lFindeHandle = findHandle
        findIn.nFileCount = BATCH

        records = (NET_RECORDSET_ACCESS_CTL_CARDREC * BATCH)()
        for rec in records:
            rec.dwSize = sizeof(NET_RECORDSET_ACCESS_CTL_CARDREC)

        findOut = NET_OUT_FIND_NEXT_RECORD_PARAM()
        findOut.dwSize = sizeof(NET_OUT_FIND_NEXT_RECORD_PARAM)
        findOut.pRecordList = cast(records, c_void_p)
        findOut.nMaxRecordNum = BATCH

        ret = sdk.FindNextRecord(findIn, findOut, 5000)
        got = findOut.nRetRecordNum
        if not ret or got == 0:
            break

        for i in range(got):
            rec = records[i]
            t = rec.stuTime
            dt_str = f"{t.dwYear}-{t.dwMonth:02d}-{t.dwDay:02d} {t.dwHour:02d}:{t.dwMinute:02d}:{t.dwSecond:02d}"
            status = "成功" if rec.bStatus else "失败"
            card = rec.szCardNo.decode('utf-8', errors='ignore')
            user = rec.szUserID.decode('utf-8', errors='ignore')
            name = rec.szCardName.decode('utf-8', errors='ignore')
            method = METHOD_MAP.get(rec.emMethod, f"未知({rec.emMethod})")
            print(f"  [{dt_str}] 门{rec.nDoor} | 用户:{user} | 姓名:{name} | 卡:{card} | {status} | {method}")
            total += 1

    print(f"\n共查到 {total} 条记录")
    sdk.FindRecordClose(findHandle)


# ------------------------------------------------------------
# 主入口
# ------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="大华门禁 SDK 操作")
    parser.add_argument("--device-ip", required=True, help="设备 IP")
    parser.add_argument("--device-port", type=int, default=37777, help="设备端口")
    parser.add_argument("--username", required=True, help="登录用户名")
    parser.add_argument("--password", required=True, help="登录密码")
    parser.add_argument("command", help="操作命令: open, adduser, getuser, deluser, face, dface, log")
    parser.add_argument("args", nargs="*", help="命令参数")

    parsed = parser.parse_args()

    ip = parsed.device_ip
    port = parsed.device_port
    username = parsed.username
    password = parsed.password
    cmd = parsed.command
    args = parsed.args

    # 特殊处理：log 命令不需要 SDK 登录，但需要 RPC 登录？这里先统一登录
    if cmd in ("open", "adduser", "getuser", "deluser", "log"):
        sdk, loginID = login(ip, port, username, password)
        if not loginID:
            sys.exit(1)
        try:
            if cmd == "open":
                ch = int(args[0]) if args else 0
                open_door(sdk, loginID, ch)
            elif cmd == "adduser" and len(args) >= 2:
                insert_user(sdk, loginID, args[0], args[1])
            elif cmd == "getuser" and len(args) >= 1:
                get_user(sdk, loginID, args[0])
            elif cmd == "deluser" and len(args) >= 1:
                remove_user(sdk, loginID, args[0])
            elif cmd == "log":
                today = datetime.datetime.now()
                start = datetime.datetime.strptime(args[0], "%Y-%m-%d") if args else today.replace(hour=0, minute=0, second=0)
                end = datetime.datetime.strptime(args[1], "%Y-%m-%d").replace(hour=23, minute=59, second=59) if len(args) >= 2 else today.replace(hour=23, minute=59, second=59)
                query_log(sdk, loginID, start, end)
            else:
                print(f"❌ 未知命令或参数不足: {cmd}")
        finally:
            logout(sdk, loginID)

    elif cmd in ("face", "dface"):
        # 人脸操作使用 CGI，不需要 SDK 登录
        if cmd == "face" and len(args) >= 2:
            user_id = args[0]
            img_path = args[1]
            max_kb = int(args[2]) if len(args) >= 3 else 0
            width = int(args[3]) if len(args) >= 4 else 0
            height = int(args[4]) if len(args) >= 5 else 0
            quality = int(args[5]) if len(args) >= 6 else 0
            insert_face(ip, username, password, user_id, img_path, max_kb, width, height, quality)
        elif cmd == "dface" and len(args) >= 1:
            remove_face(ip, username, password, args[0])
        else:
            print(f"❌ 人脸命令参数错误")
    else:
        print(f"❌ 未知命令: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()