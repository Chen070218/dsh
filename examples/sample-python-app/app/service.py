from app import repository
from app.models import Order


def handle() -> None:
    order = repository.load(Order)
    print(order)
