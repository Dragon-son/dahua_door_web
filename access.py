from NetSDK.NetSDK import NetClient
from NetSDK.SDK_Callback import fDisConnect, fHaveReConnect, fMessCallBackEx1, fAnalyzerDataCallBack
from NetSDK.SDK_Struct import *
from NetSDK.SDK_Enum import *
from ctypes import sizeof, cast, POINTER, pointer, byref, create_string_buffer, c_void_p
from PIL import Image
from requests.auth import HTTPDigestAuth
import requests
import base64
import hashlib
import datetime
import time
import os
import sys
import io

# ===== 设备连接配置 =====
# 公开仓库中不要写入真实设备地址、账号或密码。
# 可通过环境变量覆盖：
#   DAHUA_DEVICE_IP / DAHUA_DEVICE_PORT / DAHUA_DEVICE_USERNAME / DAHUA_DEVICE_PASSWORD
DEVICE_IP   = os.environ.get("DAHUA_DEVICE_IP", "127.0.0.1")
DEVICE_PORT = int(os.environ.get("DAHUA_DEVICE_PORT", "37777"))
USERNAME    = os.environ.get("DAHUA_DEVICE_USERNAME", "admin")
PASSWORD    = os.environ.get("DAHUA_DEVICE_PASSWORD", "")
# ========================

METHOD_MAP = {
    1: "刷卡", 2: "密码", 3: "卡+密码", 4: "指纹",
    5: "远程开门", 6: "按钮开门", 16: "人脸识别",
}

ERROR_CODE_MAP = {
    0x00: "没有错误",
    0x10: "未授权",
    0x11: "卡挂失或注销",
    0x12: "没有该门权限",
    0x13: "开门模式错误",
    0x14: "有效期错误",
    0x15: "防反潜模式",
    0x16: "胁迫报警未打开",
    0x17: "门常闭状态",
    0x18: "AB互锁状态",
    0x19: "巡逻卡",
    0x1A: "设备处于闯入报警状态",
    0x20: "时间段错误",
    0x21: "假期内开门时间段错误",
    0x30: "需要先验证有首卡权限的卡片",
    0x40: "卡片正确,输入密码错误",
    0x41: "卡片正确,输入密码超时",
    0x42: "卡片正确,输入错误",
    0x43: "卡片正确,输入超时",
    0x44: "验证正确,输入密码错误",
    0x45: "验证正确,输入密码超时",
    0x50: "组合开门顺序错误",
    0x51: "组合开门需要继续验证",
    0x60: "验证通过,控制台未授权",
    0x61: "卡片正确,人脸错误",
    0x62: "卡片正确,人脸超时",
    0x63: "重复进入",
    0x64: "未授权,需要后端平台识别",
    0x65: "温度过高",
    0x66: "未戴口罩",
    0x67: "健康码获取失败",
    0x68: "黄码禁止通行",
    0x69: "红码禁止通行",
    0x6A: "健康码无效",
    0x6B: "绿码验证通过",
    0x70: "获取健康码信息",
    0x71: "校验证件信息",
    0xA8: "未佩戴安全帽",
}

def describe_error_code(error_code: int) -> str:
    return ERROR_CODE_MAP.get(int(error_code), f"未知错误(0x{int(error_code) & 0xff:02x})")


def format_access_status(success: bool, error_code: int) -> str:
    if success:
        return "成功"
    return f"失败(0x{int(error_code) & 0xff:02x} {describe_error_code(error_code)})"

# ─────────────────────────────────────────
# SDK 初始化
# ─────────────────────────────────────────
sdk = NetClient()
sdk.InitEx(fDisConnect(lambda a, b, c, d: None))
sdk.SetAutoReconnect(fHaveReConnect(lambda a, b, c, d: None))

stuIn = NET_IN_LOGIN_WITH_HIGHLEVEL_SECURITY()
stuIn.dwSize     = sizeof(NET_IN_LOGIN_WITH_HIGHLEVEL_SECURITY)
stuIn.szIP       = DEVICE_IP.encode()
stuIn.nPort      = DEVICE_PORT
stuIn.szUserName = USERNAME.encode()
stuIn.szPassword = PASSWORD.encode()
stuIn.emSpecCap  = EM_LOGIN_SPAC_CAP_TYPE.TCP
stuOut = NET_OUT_LOGIN_WITH_HIGHLEVEL_SECURITY()
stuOut.dwSize = sizeof(NET_OUT_LOGIN_WITH_HIGHLEVEL_SECURITY)

loginID, _, error_msg = sdk.LoginWithHighLevelSecurity(stuIn, stuOut)
if loginID == 0:
    print(f"❌ SDK 登录失败: {error_msg}")
    sdk.Cleanup()
    exit(1)
print(f"✅ SDK 登录成功")

# ─────────────────────────────────────────
# RPC2 登录（保留，供其他功能备用）
# ─────────────────────────────────────────
RPC_LOGIN_URL = f"http://{DEVICE_IP}/RPC2_Login"
RPC_BASE_URL  = f"http://{DEVICE_IP}/RPC2"
rpc_session   = None
rpc_id        = 1


def rpc_login():
    global rpc_session, rpc_id
    try:
        r = requests.post(RPC_LOGIN_URL, json={
            "method": "global.login",
            "params": {"userName": USERNAME, "password": "", "clientType": "Web3.0"},
            "id": rpc_id,
            "session": 0
        }, timeout=10)
        rpc_id += 1
        data = r.json()

        realm      = data["params"]["realm"]
        random_key = data["params"]["random"]
        session    = data["session"]

        pwd_md5    = hashlib.md5(f"{USERNAME}:{realm}:{PASSWORD}".encode()).hexdigest().upper()
        login_hash = hashlib.md5(f"{USERNAME}:{random_key}:{pwd_md5}".encode()).hexdigest().upper()

        r2 = requests.post(RPC_LOGIN_URL, json={
            "method": "global.login",
            "params": {
                "userName": USERNAME,
                "password": login_hash,
                "clientType": "Web3.0",
                "authorityType": "Default",
                "passwordType": "Default"
            },
            "id": rpc_id,
            "session": session
        }, timeout=10)
        rpc_id += 1
        data2 = r2.json()

        if data2.get("result"):
            rpc_session = data2["session"]
            print(f"✅ RPC 登录成功")
            return True
        else:
            print(f"❌ RPC 登录失败: {data2}")
            return False
    except Exception as e:
        print(f"❌ RPC 登录异常: {e}")
        return False


def rpc_call(method, params):
    global rpc_id
    r = requests.post(RPC_BASE_URL, json={
        "method": method,
        "params": params,
        "id": rpc_id,
        "session": rpc_session
    }, timeout=30)
    rpc_id += 1
    return r.json()


# ─────────────────────────────────────────
# 工具函数
# ─────────────────────────────────────────
def make_net_time(dt: datetime.datetime) -> NET_TIME:
    t = NET_TIME()
    t.dwYear   = dt.year
    t.dwMonth  = dt.month
    t.dwDay    = dt.day
    t.dwHour   = dt.hour
    t.dwMinute = dt.minute
    t.dwSecond = dt.second
    return t


def compress_image(image_path: str, max_size: int = 0, width: int = 0, height: int = 0, quality: int = 0) -> bytes:
    """
    max_size : 限制文件大小（KB），0表示不限制
    width    : 缩放宽度，0表示不缩放
    height   : 缩放高度，0表示不缩放
    quality  : JPEG质量 1-95，0表示不压缩直接读原图
    """
    if max_size == 0 and width == 0 and height == 0 and quality == 0:
        # 默认不压缩，直接读取原图
        with open(image_path, "rb") as f:
            data = f.read()
        print(f"  原图大小: {len(data)} 字节")
        return data

    img = Image.open(image_path).convert("RGB")

    if width > 0 and height > 0:
        img = img.resize((width, height))
    elif width > 0 or height > 0:
        img.thumbnail((width or 9999, height or 9999))

    q = quality if quality > 0 else 85
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=q)
    data = buf.getvalue()
    print(f"  压缩后大小: {len(data)} 字节 (quality={q})")
    return data


# ─────────────────────────────────────────
# 人员管理
# ─────────────────────────────────────────
def insert_user(user_id: str, name: str,
                door_list: list = None,
                valid_begin: datetime.datetime = None,
                valid_end: datetime.datetime = None):
    if door_list is None:
        door_list = [0]
    if valid_begin is None:
        valid_begin = datetime.datetime(2000, 1, 1)
    if valid_end is None:
        valid_end = datetime.datetime(2037, 12, 31)

    user = NET_ACCESS_USER_INFO()
    user.szUserID        = user_id.encode()
    user.szName          = name.encode('utf-8')
    user.emUserType      = EM_A_NET_ENUM_USER_TYPE.NET_ENUM_USER_TYPE_NORMAL
    user.nUserStatus     = 0
    user.nDoorNum        = len(door_list)
    for i, d in enumerate(door_list):
        user.nDoors[i] = d
    user.stuValidBeginTime = make_net_time(valid_begin)
    user.stuValidEndTime   = make_net_time(valid_end)

    fail_codes = (C_ENUM * 1)()
    inParam = NET_IN_ACCESS_USER_SERVICE_INSERT()
    inParam.dwSize    = sizeof(NET_IN_ACCESS_USER_SERVICE_INSERT)
    inParam.nInfoNum  = 1
    inParam.pUserInfo = pointer(user)
    outParam = NET_OUT_ACCESS_USER_SERVICE_INSERT()
    outParam.dwSize     = sizeof(NET_OUT_ACCESS_USER_SERVICE_INSERT)
    outParam.nMaxRetNum = 1
    outParam.pFailCode  = cast(fail_codes, POINTER(C_ENUM))

    result = sdk.OperateAccessUserService(
        loginID,
        EM_A_NET_EM_ACCESS_CTL_USER_SERVICE.NET_EM_ACCESS_CTL_USER_SERVICE_INSERT,
        inParam, outParam, 5000
    )
    if result:
        print(f"✅ 添加人员成功: {user_id} / {name}")
    else:
        print(f"❌ 添加人员失败: {sdk.GetLastErrorMessage()} "
              f"(错误码:{sdk.GetLastError()} FailCode:{fail_codes[0]})")


def get_user(user_id: str):
    fail_codes = (C_ENUM * 1)()
    users = (NET_ACCESS_USER_INFO * 1)()
    inParam = NET_IN_ACCESS_USER_SERVICE_GET()
    inParam.dwSize   = sizeof(NET_IN_ACCESS_USER_SERVICE_GET)
    inParam.nUserNum = 1
    inParam.szUserID = user_id.encode().ljust(32, b'\x00')
    outParam = NET_OUT_ACCESS_USER_SERVICE_GET()
    outParam.dwSize     = sizeof(NET_OUT_ACCESS_USER_SERVICE_GET)
    outParam.nMaxRetNum = 1
    outParam.pUserInfo  = cast(users, POINTER(NET_ACCESS_USER_INFO))
    outParam.pFailCode  = cast(fail_codes, POINTER(C_ENUM))

    result = sdk.OperateAccessUserService(
        loginID,
        EM_A_NET_EM_ACCESS_CTL_USER_SERVICE.NET_EM_ACCESS_CTL_USER_SERVICE_GET,
        inParam, outParam, 5000
    )
    if result:
        u      = users[0]
        name   = u.szName.decode('utf-8', errors='ignore')
        status = "正常" if u.nUserStatus == 0 else "冻结"
        doors  = [u.nDoors[i] for i in range(u.nDoorNum)]
        b, e   = u.stuValidBeginTime, u.stuValidEndTime
        print(f"✅ 查询成功:")
        print(f"   ID    : {user_id}")
        print(f"   姓名  : {name}")
        print(f"   状态  : {status}")
        print(f"   门权限: {doors}")
        print(f"   有效期: {b.dwYear}-{b.dwMonth:02d}-{b.dwDay:02d} "
              f"~ {e.dwYear}-{e.dwMonth:02d}-{e.dwDay:02d}")
    else:
        print(f"❌ 查询失败: {sdk.GetLastErrorMessage()} "
              f"(错误码:{sdk.GetLastError()} FailCode:{fail_codes[0]})")


def remove_user(user_id: str):
    fail_codes = (C_ENUM * 1)()
    inParam = NET_IN_ACCESS_USER_SERVICE_REMOVE()
    inParam.dwSize   = sizeof(NET_IN_ACCESS_USER_SERVICE_REMOVE)
    inParam.nUserNum = 1
    inParam.szUserID = user_id.encode().ljust(32, b'\x00')
    outParam = NET_OUT_ACCESS_USER_SERVICE_REMOVE()
    outParam.dwSize     = sizeof(NET_OUT_ACCESS_USER_SERVICE_REMOVE)
    outParam.nMaxRetNum = 1
    outParam.pFailCode  = cast(fail_codes, POINTER(C_ENUM))

    result = sdk.OperateAccessUserService(
        loginID,
        EM_A_NET_EM_ACCESS_CTL_USER_SERVICE.NET_EM_ACCESS_CTL_USER_SERVICE_REMOVE,
        inParam, outParam, 5000
    )
    if result:
        print(f"✅ 删除人员成功: {user_id}")
    else:
        print(f"❌ 删除人员失败: {sdk.GetLastErrorMessage()} "
              f"(错误码:{sdk.GetLastError()} FailCode:{fail_codes[0]})")


def find_user_by_name(name: str) -> list:
    """按姓名查找人员（逐个查询，避免批量限制）"""
    condition = NET_A_FIND_RECORD_ACCESSCTLCARD_CONDITION()
    condition.dwSize = sizeof(NET_A_FIND_RECORD_ACCESSCTLCARD_CONDITION)
    condition.abCardNo = False
    condition.abUserID = False
    condition.abIsValid = False

    inParam = NET_IN_FIND_RECORD_PARAM()
    inParam.dwSize = sizeof(NET_IN_FIND_RECORD_PARAM)
    inParam.emType = EM_NET_RECORD_TYPE.ACCESSCTLCARD
    inParam.pQueryCondition = cast(byref(condition), c_void_p)

    outParam = NET_OUT_FIND_RECORD_PARAM()
    outParam.dwSize = sizeof(NET_OUT_FIND_RECORD_PARAM)

    result = sdk.FindRecord(loginID, inParam, outParam, 5000)
    if not result:
        print(f"❌ FindRecord 失败: {sdk.GetLastErrorMessage()}")
        return []

    findHandle = outParam.lFindeHandle
    all_user_ids = []
    batch = 50

    while True:
        findIn = NET_IN_FIND_NEXT_RECORD_PARAM()
        findIn.dwSize = sizeof(NET_IN_FIND_NEXT_RECORD_PARAM)
        findIn.lFindeHandle = findHandle
        findIn.nFileCount = batch

        records = (NET_RECORDSET_ACCESS_CTL_CARD * batch)()
        for rec in records:
            rec.dwSize = sizeof(NET_RECORDSET_ACCESS_CTL_CARD)

        findOut = NET_OUT_FIND_NEXT_RECORD_PARAM()
        findOut.dwSize = sizeof(NET_OUT_FIND_NEXT_RECORD_PARAM)
        findOut.pRecordList = cast(records, c_void_p)
        findOut.nMaxRecordNum = batch

        ret = sdk.FindNextRecord(findIn, findOut, 5000)
        got = findOut.nRetRecordNum
        if not ret or got == 0:
            break

        for i in range(got):
            uid = records[i].szUserID.decode('utf-8', errors='ignore').strip('\x00')
            if uid and uid not in all_user_ids:
                all_user_ids.append(uid)

    sdk.FindRecordClose(findHandle)
    print(f"  共找到 {len(all_user_ids)} 个 UserID，开始逐个查询详情...")

    matched = []
    for idx, uid in enumerate(all_user_ids):
        if (idx + 1) % 10 == 0:
            print(f"    进度: {idx + 1}/{len(all_user_ids)}")

        fail_codes = (C_ENUM * 1)()
        users = (NET_ACCESS_USER_INFO * 1)()

        inParam = NET_IN_ACCESS_USER_SERVICE_GET()
        inParam.dwSize = sizeof(NET_IN_ACCESS_USER_SERVICE_GET)
        inParam.nUserNum = 1
        inParam.szUserID = uid.encode().ljust(32, b'\x00')

        outParam = NET_OUT_ACCESS_USER_SERVICE_GET()
        outParam.dwSize = sizeof(NET_OUT_ACCESS_USER_SERVICE_GET)
        outParam.nMaxRetNum = 1
        outParam.pUserInfo = cast(users, POINTER(NET_ACCESS_USER_INFO))
        outParam.pFailCode = cast(fail_codes, POINTER(C_ENUM))

        ok = sdk.OperateAccessUserService(
            loginID,
            EM_A_NET_EM_ACCESS_CTL_USER_SERVICE.NET_EM_ACCESS_CTL_USER_SERVICE_GET,
            inParam, outParam, 5000
        )
        if not ok:
            continue

        u = users[0]
        u_name = u.szName.decode('utf-8', errors='ignore').strip('\x00')
        if name in u_name:
            matched.append({
                "id": uid,
                "name": u_name,
                "status": "正常" if u.nUserStatus == 0 else "冻结",
                "doors": [u.nDoors[k] for k in range(u.nDoorNum)],
            })

    return matched


# ─────────────────────────────────────────
# 人脸管理（CGI 接口 - 推荐，更稳定，支持更大图片）
# ─────────────────────────────────────────
def cgi_post(action: str, payload: dict):
    """通用的 CGI POST（带 Digest 认证）"""
    url = f"http://{DEVICE_IP}/cgi-bin/FaceInfoManager.cgi?action={action}"
    try:
        r = requests.post(
            url,
            json=payload,
            auth=HTTPDigestAuth(USERNAME, PASSWORD),
            timeout=30
        )
        text = r.text.strip()
        # 大华 CGI 成功通常返回 "OK" 或包含 "result":true 的 JSON
        if r.status_code == 200 and (text in ("OK", "ok") or '"result": true' in text.lower() or "success" in text.lower()):
            return True, text or "OK"
        else:
            return False, f"HTTP {r.status_code}: {text}"
    except Exception as e:
        return False, f"请求异常: {e}"


def insert_face(user_id: str, image_path: str,
                max_kb: int = 0, width: int = 0, height: int = 0, quality: int = 0):
    """下发人脸（CGI，默认不压缩原图）"""
    img_bytes = compress_image(image_path, max_kb, width, height, quality)
    img_b64   = base64.b64encode(img_bytes).decode("utf-8")

    payload = {
        "UserID": user_id,
        "Info": {
            "PhotoData": [img_b64]
            # 可选添加: "UserName": "姓名", "FaceData": [...] 等
        }
    }

    success, msg = cgi_post("add", payload)
    if success:
        print(f"✅ 人脸下发成功: {user_id} (CGI)")
    else:
        print(f"❌ 人脸下发失败: {msg}")


def remove_face(user_id: str):
    """删除人脸"""
    payload = {
        "UserIDList": [user_id]
    }
    success, msg = cgi_post("delete", payload)
    if success:
        print(f"✅ 人脸删除成功: {user_id} (CGI)")
    else:
        print(f"❌ 人脸删除失败: {msg}")
        # 如果你的设备 delete 不行，可取消下面一行的注释改用 remove
        # success, msg = cgi_post("remove", {"UserIDList": [user_id]})


# ─────────────────────────────────────────
# 远程开门
# ─────────────────────────────────────────
def open_door(channel: int = 0):
    ctrl = NET_CTRL_ACCESS_OPEN()
    ctrl.dwSize              = sizeof(NET_CTRL_ACCESS_OPEN)
    ctrl.nChannelID          = channel
    ctrl.szTargetID          = None
    ctrl.emOpenDoorType      = EM_OPEN_DOOR_TYPE.EM_OPEN_DOOR_TYPE_REMOTE
    ctrl.emOpenDoorDirection = EM_OPEN_DOOR_DIRECTION.EM_OPEN_DOOR_DIRECTION_UNKNOWN
    result = sdk.ControlDevice(loginID, CtrlType.ACCESS_OPEN, ctrl, 5000)
    if result:
        print(f"✅ 远程开门成功 (门{channel})")
    else:
        print(f"❌ 远程开门失败: {sdk.GetLastErrorMessage()} (错误码:{sdk.GetLastError()})")

        
# ─────────────────────────────────────────
# 查询开门日志
# ─────────────────────────────────────────
def query_log(start: datetime.datetime, end: datetime.datetime):
    condition = NET_FIND_RECORD_ACCESSCTLCARDREC_CONDITION_EX()
    condition.dwSize      = sizeof(NET_FIND_RECORD_ACCESSCTLCARDREC_CONDITION_EX)
    condition.bTimeEnable = True
    condition.stStartTime = make_net_time(start)
    condition.stEndTime   = make_net_time(end)
    condition.nOrderNum   = 0

    inParam = NET_IN_FIND_RECORD_PARAM()
    inParam.dwSize          = sizeof(NET_IN_FIND_RECORD_PARAM)
    inParam.emType          = EM_NET_RECORD_TYPE.ACCESSCTLCARDREC_EX
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
        findIn.dwSize       = sizeof(NET_IN_FIND_NEXT_RECORD_PARAM)
        findIn.lFindeHandle = findHandle
        findIn.nFileCount   = BATCH

        records = (NET_RECORDSET_ACCESS_CTL_CARDREC * BATCH)()
        for rec in records:
            rec.dwSize = sizeof(NET_RECORDSET_ACCESS_CTL_CARDREC)

        findOut = NET_OUT_FIND_NEXT_RECORD_PARAM()
        findOut.dwSize        = sizeof(NET_OUT_FIND_NEXT_RECORD_PARAM)
        findOut.pRecordList   = cast(records, c_void_p)
        findOut.nMaxRecordNum = BATCH

        ret = sdk.FindNextRecord(findIn, findOut, 5000)
        got = findOut.nRetRecordNum
        if not ret or got == 0:
            break

        for i in range(got):
            rec    = records[i]
            t      = rec.stuTime
            dt_str = (f"{t.dwYear}-{t.dwMonth:02d}-{t.dwDay:02d} "
                      f"{t.dwHour:02d}:{t.dwMinute:02d}:{t.dwSecond:02d}")
            status = format_access_status(rec.bStatus, getattr(rec, 'nErrorCode', 0))
            card   = rec.szCardNo.decode('utf-8', errors='ignore')
            user   = rec.szUserID.decode('utf-8', errors='ignore')
            name   = rec.szCardName.decode('utf-8', errors='ignore')
            method = METHOD_MAP.get(rec.emMethod, f"未知({rec.emMethod})")
            print(f"  [{dt_str}] 门{rec.nDoor} | 用户:{user} | 姓名:{name} "
                  f"| 卡:{card} | {status} | {method}")
            total += 1

    print(f"\n共查到 {total} 条记录")
    sdk.FindRecordClose(findHandle)


# ─────────────────────────────────────────
# 实时监听开门事件
# ─────────────────────────────────────────
def on_alarm(lCommand, lLoginID, pBuf, dwBufLen, pchDVRIP, nDVRPort,
             bAlarmAckFlag, nEventHandle, dwUser):
    try:
        if lCommand == 0x00000204:
            event  = cast(pBuf, POINTER(DEV_EVENT_ACCESS_CTL_INFO)).contents
            t      = event.UTC
            dt_str = (f"{t.dwYear}-{t.dwMonth:02d}-{t.dwDay:02d} "
                      f"{t.dwHour:02d}:{t.dwMinute:02d}:{t.dwSecond:02d}")
            name   = event.szName.decode('utf-8', errors='ignore')
            card   = event.szCardNo.decode('utf-8', errors='ignore')
            user   = event.szUserID.decode('utf-8', errors='ignore')
            status = format_access_status(event.bStatus, event.nErrorCode)
            method = METHOD_MAP.get(int(event.emOpenMethod), f"未知({event.emOpenMethod})")
            print(f"🔔 [消息] [{dt_str}] 门{event.nChannelID} | 用户:{user} "
                  f"| {name} | 卡:{card} | {status} | {method}")
        elif lCommand == int(SDK_ALARM_TYPE.ALARM_ACCESS_CTL_STATUS):
            event = cast(pBuf, POINTER(NET_A_ALARM_ACCESS_CTL_STATUS_INFO)).contents
            t = event.RealUTC if getattr(event, 'bRealUTC', False) else event.stuTime
            dt_str = (f"{t.dwYear}-{t.dwMonth:02d}-{t.dwDay:02d} "
                      f"{t.dwHour:02d}:{t.dwMinute:02d}:{t.dwSecond:02d}")
            status = STATUS_MAP.get(int(event.emStatus), f"未知({event.emStatus})")
            serial = event.szSerialNumber.decode('utf-8', errors='ignore').strip('\x00')
            extra = f" | 序列号:{serial}" if serial else ""
            print(f"🔔 [状态] [{dt_str}] 门{event.nDoor} | {status}{extra}")
    except Exception as e:
        print(f"⚠️  消息回调异常: {e}")


def on_analyzer(lAnalyzerHandle, dwEventType, pEventInfo, pBuffer,
                dwBufSize, dwUser, nSequence, reserved):
    try:
        if dwEventType == 0x00000204:
            event  = cast(pEventInfo, POINTER(DEV_EVENT_ACCESS_CTL_INFO)).contents
            t      = event.UTC
            dt_str = (f"{t.dwYear}-{t.dwMonth:02d}-{t.dwDay:02d} "
                      f"{t.dwHour:02d}:{t.dwMinute:02d}:{t.dwSecond:02d}")
            name   = event.szName.decode('utf-8', errors='ignore')
            card   = event.szCardNo.decode('utf-8', errors='ignore')
            user   = event.szUserID.decode('utf-8', errors='ignore')
            status = format_access_status(event.bStatus, event.nErrorCode)
            method = METHOD_MAP.get(int(event.emOpenMethod), f"未知({event.emOpenMethod})")
            print(f"🔔 [智能] [{dt_str}] 门{event.nChannelID} | 用户:{user} "
                  f"| {name} | 卡:{card} | {status} | {method}")
    except Exception as e:
        print(f"⚠️  智能回调异常: {e}")


def start_listen():
    msg_cb = fMessCallBackEx1(on_alarm)
    start_listen._msg_cb = msg_cb
    sdk.SetDVRMessCallBackEx1(msg_cb, 0)

    ana_cb = fAnalyzerDataCallBack(on_analyzer)
    start_listen._ana_cb = ana_cb
    handle = sdk.RealLoadPictureEx(loginID, 0, 0x00000204, 1, ana_cb, 0, None)
    start_listen._handle = handle
    print(f"  智能订阅句柄: {handle}")

    result = sdk.StartListenEx(loginID)
    if result:
        print("✅ 监听已启动，按 Ctrl+C 退出...")
    else:
        print(f"❌ 监听启动失败: {sdk.GetLastErrorMessage()}")
    return result
def get_door_status_cgi(channel: int = 1):
    """查询门状态（优先 getLockStatus）"""
    urls = [
        f"http://{DEVICE_IP}/cgi-bin/accessControl.cgi?action=getLockStatus&channel={channel}",
        f"http://{DEVICE_IP}/cgi-bin/accessControl.cgi?action=getDoorStatus&channel={channel}"
    ]
    
    for url in urls:
        try:
            r = requests.get(
                url,
                auth=HTTPDigestAuth(USERNAME, PASSWORD),
                timeout=10
            )
            text = r.text.strip()
            print(f"调试 [{url}] 返回: {text}")
            
            if r.status_code == 200:
                # 解析 status=Open / Close
                if 'status=' in text:
                    status = text.split('status=')[-1].split('\n')[0].strip()
                    return True, status
                # 解析 Info.status=Open
                elif 'Info.status=' in text:
                    status = text.split('Info.status=')[-1].split('\n')[0].strip()
                    return True, status
                return True, text  # 返回原始内容
        except Exception as e:
            print(f"请求异常: {e}")
            continue
    return False, "查询失败（请尝试其他 channel）"

# ─────────────────────────────────────────
# 主入口
# ─────────────────────────────────────────
USAGE = """
用法:
  python3 access.py open [门号]                  # SDK 远程开门，默认门0
  python3 access.py doorstatus [门号]            # CGI 查询门状态，默认门1
  python3 access.py adduser <ID> <姓名>          # 添加人员
  python3 access.py getuser <ID>                 # 查询人员
  python3 access.py finduser <姓名>              # 按姓名查找人员
  python3 access.py deluser <ID>                 # 删除人员
  python3 access.py face   <ID> <图片路径>       # 下发人脸（CGI，默认不压缩原图）
  python3 access.py dface  <ID>                  # 删除人脸
  python3 access.py log [开始日期] [结束日期]    # 查询日志 格式: 2026-04-21
  python3 access.py listen                       # 实时监听开门事件（含门状态事件）

人脸命令额外参数（可选）:
  face <ID> <图片> [max_kb] [宽] [高] [quality]   # 例如: face 1001 photo.jpg 0 400 400 75
"""

if len(sys.argv) < 2:
    print(USAGE)
    sdk.Logout(loginID)
    sdk.Cleanup()
    exit(0)

cmd = sys.argv[1]

if cmd == "open":
    ch = int(sys.argv[2]) if len(sys.argv) >= 3 else 0
    open_door(ch)
    
elif cmd == "doorstatus":
    ch = int(sys.argv[2]) if len(sys.argv) >= 3 else 1
    success, status = get_door_status_cgi(ch)
    if success:
        print(f"✅ 门{ch} 状态: {status}")
    else:
        print(f"❌ {status}")

elif cmd == "adduser" and len(sys.argv) >= 4:
    insert_user(sys.argv[2], sys.argv[3])

elif cmd == "getuser" and len(sys.argv) >= 3:
    get_user(sys.argv[2])

elif cmd == "finduser" and len(sys.argv) >= 3:
    results = find_user_by_name(sys.argv[2])
    if results:
        print(f"✅ 找到 {len(results)} 条结果:")
        for item in results:
            print(f"   ID:{item['id']} | 姓名:{item['name']} | 状态:{item['status']} | 门权限:{item['doors']}")
    else:
        print("❌ 未找到匹配人员")

elif cmd == "deluser" and len(sys.argv) >= 3:
    remove_user(sys.argv[2])

elif cmd == "face" and len(sys.argv) >= 4:
    # 用法: face <ID> <图片> [max_kb] [宽] [高] [quality]
    # 默认不压缩（max_kb=0, width=0, height=0, quality=0）
    max_kb  = int(sys.argv[4]) if len(sys.argv) >= 5 else 0
    w       = int(sys.argv[5]) if len(sys.argv) >= 6 else 0
    h       = int(sys.argv[6]) if len(sys.argv) >= 7 else 0
    q       = int(sys.argv[7]) if len(sys.argv) >= 8 else 0
    insert_face(sys.argv[2], sys.argv[3], max_kb, w, h, q)

elif cmd == "dface" and len(sys.argv) >= 3:
    remove_face(sys.argv[2])

elif cmd == "log":
    today = datetime.datetime.now()
    start = datetime.datetime.strptime(sys.argv[2], "%Y-%m-%d") \
            if len(sys.argv) >= 3 else today.replace(hour=0, minute=0, second=0)
    end   = datetime.datetime.strptime(sys.argv[3], "%Y-%m-%d").replace(hour=23, minute=59, second=59) \
            if len(sys.argv) >= 4 else today.replace(hour=23, minute=59, second=59)
    query_log(start, end)
elif cmd == "status":
    ch = int(sys.argv[2]) if len(sys.argv) >= 3 else 0
    query_door_status(ch)
    
elif cmd == "listen":
    if start_listen():
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            sdk.StopListen(loginID)
            print("\n监听已停止")

else:
    print(USAGE)

sdk.Logout(loginID)
sdk.Cleanup()