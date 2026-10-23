from app import service


class Order:
    def __init__(self, **kwargs: object) -> None:
        self.fields = kwargs

    def label(self) -> str:
        return str(service)
