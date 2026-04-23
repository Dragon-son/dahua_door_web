# server.py

from flask import Flask, request, jsonify, send_from_directory
import json
import os
import threading
import time
import argparse
from datetime import datetime

from device_manager import DeviceManager

BASE = os.path.dirname(os.path.abspath(__file__))
DEV_FILE = os.path.join(BASE, "devices.json")
AREA_FILE = os.path.join(BASE, "areas.json")

app = Flask(__name__)
manager = DeviceManager()

# ================= 工具 =================

def ok(data=None):
    return jsonify({"code": 0, "msg": "ok", "data": data})

def err(msg, code=400):
    return jsonify({"code": -1, "msg": str(msg)}), code

def load_devices():
    if not os.path.exists(DEV_FILE):
        return []
    with open(DEV_FILE, encoding="utf-8") as f:
        return json.load(f)

def save_devices(devs):
    with open(DEV_FILE, "w", encoding="utf-8") as f:
        json.dump(devs, f, indent=2, ensure_ascii=False)

def get_next_id(devs):
    return max([d["id"] for d in devs], default=0) + 1

def load_areas():
    if not os.path.exists(AREA_FILE):
        areas = ["A区", "B区", "C区"]
        save_areas(areas)
        return areas
    with open(AREA_FILE, encoding="utf-8") as f:
        return json.load(f)

def save_areas(areas):
    with open(AREA_FILE, "w", encoding="utf-8") as f:
        json.dump(areas, f, indent=2, ensure_ascii=False)

# ✅ 修复：支持 GET / POST / JSON / FORM 全部来源
def extract_device():
    data = {}

    if request.is_json:
        data.update(request.get_json(silent=True) or {})

    if request.form:
        data.update(request.form.to_dict())

    if request.args:
        for k, v in request.args.items():
            if k not in data:
                data[k] = v

    ip = data.get("device_ip")
    username = data.get("username")
    password = data.get("password")

    if not ip or not username or not password:
        raise Exception("缺少 device_ip / username / password")

    return {
        "ip": ip,
        "port": int(data.get("device_port", 37777)),
        "username": username,
        "password": password,
    }

# ================= 静态 =================

@app.route("/")
@app.route("/<path:filename>")
def static_files(filename="access_control.html"):
    return send_from_directory(BASE, filename)

# ================= 健康 =================

@app.route("/api/health", methods=["GET"])
def health():
    return ok({
        "status": "running",
        "time": datetime.now().isoformat()
    })

# ================= 设备 =================

@app.route("/api/devices", methods=["GET"])
def get_devices():
    return ok(load_devices())

@app.route("/api/devices", methods=["POST"])
def add_device():
    data = request.get_json()

    if not data.get("name") or not data.get("ip"):
        return err("name 和 ip 必填")

    devs = load_devices()

    new_dev = {
        "id": get_next_id(devs),
        "name": data["name"],
        "ip": data["ip"],
        "port": int(data.get("port", 37777)),
        "username": data.get("username", "admin"),
        "password": data.get("password", ""),
        "area": data.get("area", "A区"),
        "note": data.get("note", "")
    }

    devs.append(new_dev)
    save_devices(devs)

    return ok(new_dev)

@app.route("/api/devices/<int:device_id>", methods=["PUT"])
def update_device(device_id):
    data = request.get_json()
    devs = load_devices()

    for d in devs:
        if d["id"] == device_id:
            d.update({
                "name": data.get("name", d["name"]),
                "ip": data.get("ip", d["ip"]),
                "port": int(data.get("port", d["port"])),
                "username": data.get("username", d["username"]),
                "password": data.get("password", d["password"]),
                "area": data.get("area", d.get("area", "A区")),
                "note": data.get("note", d.get("note", ""))
            })
            save_devices(devs)
            return ok(d)

    return err("设备不存在", 404)

@app.route("/api/devices/<int:device_id>", methods=["DELETE"])
def delete_device(device_id):
    devs = load_devices()
    new_devs = [d for d in devs if d["id"] != device_id]

    if len(new_devs) == len(devs):
        return err("设备不存在", 404)

    save_devices(new_devs)
    return ok({"deleted_id": device_id})

# ================= 区域 =================

@app.route("/api/areas", methods=["GET"])
def get_areas():
    return ok(load_areas())

@app.route("/api/areas", methods=["POST"])
def add_area():
    name = request.json.get("name", "").strip()

    if not name:
        return err("区域名称不能为空")

    areas = load_areas()
    if name in areas:
        return err("区域已存在")

    areas.append(name)
    save_areas(areas)

    return ok(areas)

@app.route("/api/areas/<name>", methods=["DELETE"])
def delete_area(name):
    areas = load_areas()

    if name not in areas:
        return err("区域不存在", 404)

    devs = load_devices()
    if any(d.get("area") == name for d in devs):
        return err("该区域下有设备，无法删除")

    areas.remove(name)
    save_areas(areas)

    return ok({"deleted": name})

# ================= 门禁 =================

@app.route("/api/open", methods=["POST"])
def open_door():
    try:
        dev = extract_device()
        channel = int((request.get_json() or {}).get("channel", 0))

        manager.get(dev).open_door(channel)
        return ok({"channel": channel})
    except Exception as e:
        return err(e, 500)

# ================= 人员 =================

@app.route("/api/user", methods=["POST"])
def add_user():
    try:
        dev = extract_device()
        data = request.get_json()

        manager.get(dev).add_user(data["user_id"], data["name"])
        return ok()
    except Exception as e:
        return err(e, 500)

@app.route("/api/user/<uid>", methods=["DELETE"])
def del_user(uid):
    try:
        dev = extract_device()
        manager.get(dev).delete_user(uid)
        return ok()
    except Exception as e:
        return err(e, 500)

# ================= 人员搜索 =================
@app.route("/api/device/user/id/<uid>", methods=["GET"])
def get_device_user_by_id(uid):
    """按用户ID精确查询设备人员"""
    try:
        dev = extract_device()
        client = manager.get(dev)
        user = client.get_user_by_id(uid)
        if user:
            return ok(user)
        else:
            return err("用户不存在", 404)
    except Exception as e:
        return err(str(e), 500)

@app.route("/api/device/users/search", methods=["GET"])
def search_device_users_by_name():
    """按姓名模糊搜索设备人员"""
    try:
        dev = extract_device()
        keyword = request.args.get("keyword", "").strip()
        if not keyword:
            return err("缺少 keyword 参数")
        client = manager.get(dev)
        users = client.search_users_by_name(keyword)
        return ok({"total": len(users), "items": users})
    except Exception as e:
        return err(str(e), 500)
# ================= 人脸 =================

@app.route("/api/face/<uid>", methods=["POST"])
def add_face(uid):
    try:
        dev = extract_device()
        f = request.files["file"]

        path = os.path.join(BASE, f"_tmp_{uid}.jpg")
        f.save(path)

        manager.get(dev).add_face(uid, path)

        if os.path.exists(path):
            os.remove(path)

        return ok()
    except Exception as e:
        return err(e, 500)

@app.route("/api/face/<uid>", methods=["DELETE"])
def del_face(uid):
    try:
        dev = extract_device()
        manager.get(dev).delete_face(uid)
        return ok()
    except Exception as e:
        return err(e, 500)
        
@app.route("/api/device/users/all", methods=["GET"])
def get_all_device_users():
    """分页获取设备人员"""
    try:
        dev = extract_device()
        page = int(request.args.get("page", 1))
        page_size = int(request.args.get("page_size", 20))
        if page < 1: page = 1
        if page_size < 1 or page_size > 100: page_size = 20
        
        offset = (page - 1) * page_size
        client = manager.get(dev)
        total, users = client.get_users_paginated(offset, page_size)
        return ok({
            "total": total,
            "page": page,
            "page_size": page_size,
            "items": users
        })
    except Exception as e:
        return err(str(e), 500)

# ================= 日志（已彻底修复） =================

@app.route("/api/log", methods=["GET"])
def log():
    try:
        dev = extract_device()

        start_str = request.args.get("start")
        end_str = request.args.get("end")

        if not start_str or not end_str:
            return err("缺少 start 或 end 参数")

        start = datetime.strptime(start_str, "%Y-%m-%d")
        end = datetime.strptime(end_str, "%Y-%m-%d")

        # ✅ 修复：包含整天
        end = end.replace(hour=23, minute=59, second=59)

        records = manager.get(dev).query_log(start, end)

        return ok({
            "total": len(records),
            "records": records
        })

    except Exception as e:
        return err(e, 500)

# ================= 清理线程 =================

def cleaner():
    while True:
        time.sleep(60)
        manager.cleanup()

threading.Thread(target=cleaner, daemon=True).start()

# ================= 启动 =================

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=15001)
    args = parser.parse_args()

    app.run("0.0.0.0", args.port)