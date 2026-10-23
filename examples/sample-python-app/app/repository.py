import json
import os

from app.models import Order


def load(model: type) -> object:
    path = os.environ.get('DATA_PATH', 'data.json')
    with open(path, 'r', encoding='utf-8') as source:
        return model(**json.load(source))
