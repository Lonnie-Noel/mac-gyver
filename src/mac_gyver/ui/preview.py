import time

from PySide6.QtCore import Qt, Signal, QRectF, QPointF
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QWidget

from ..coordinates import fit_rect, normalized_point


class PhonePreview(QWidget):
    gesture = Signal(dict)
    input_started = Signal()
    entered = Signal()
    left = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(240, 360)
        self.setMouseTracking(True)
        self.pixmap = QPixmap()
        self.tool = "tap"
        self.input_enabled = False
        self.first = None
        self.last = None
        self.pressed_at = 0.0
        self.highlight = None

    def set_image(self, data):
        pixmap = QPixmap()
        if not pixmap.loadFromData(data):
            raise ValueError("아이폰 화면을 읽을 수 없습니다.")
        self.pixmap = pixmap
        self.update()

    def image_rect(self):
        if self.pixmap.isNull():
            return (0, 0, 0, 0)
        x, y, w, h = fit_rect(max(1, self.width()-24), max(1, self.height()-24),
                              self.pixmap.width(), self.pixmap.height())
        return x+12, y+12, w, h

    def point(self, position):
        return normalized_point(position.x(), position.y(), self.image_rect())

    def set_input_enabled(self, value):
        self.input_enabled = value
        self.setCursor(Qt.CrossCursor if value else Qt.ArrowCursor)
        if not value:
            self.first = None
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        painter.fillRect(self.rect(), QColor("#0c1220"))
        if self.pixmap.isNull():
            painter.setPen(QColor("#94a3b8"))
            painter.drawText(self.rect(), Qt.AlignCenter,
                             "아이폰을 연결해 주세요\n\n또는 ‘데모 기기’를 선택해\n기록과 편집을 먼저 살펴보세요.")
            return
        rect = QRectF(*self.image_rect())
        painter.drawPixmap(rect, self.pixmap, QRectF(self.pixmap.rect()))
        painter.setPen(QPen(QColor("#48cbb6"), 2))
        if self.highlight:
            r = self.highlight
            painter.drawRect(QRectF(rect.x()+r["x"]*rect.width(), rect.y()+r["y"]*rect.height(),
                                    r["width"]*rect.width(), r["height"]*rect.height()))
        if self.first:
            first = QPointF(rect.x()+self.first["x"]*rect.width(), rect.y()+self.first["y"]*rect.height())
            painter.setBrush(QColor("#48cbb6"))
            painter.drawEllipse(first, 5, 5)
            if self.last:
                last = QPointF(rect.x()+self.last["x"]*rect.width(), rect.y()+self.last["y"]*rect.height())
                if self.tool == "assert_image":
                    painter.setBrush(QColor(72, 203, 182, 40))
                    painter.drawRect(QRectF(first, last).normalized())
                else:
                    painter.drawLine(first, last)
                    painter.drawEllipse(last, 5, 5)

    def mousePressEvent(self, event):
        if event.button() != Qt.LeftButton or not self.input_enabled:
            return
        point = self.point(event.position())
        if point is None:
            return
        self.first = self.last = point
        self.pressed_at = time.monotonic()
        self.input_started.emit()
        self.update()

    def mouseMoveEvent(self, event):
        if self.first and (point := self.point(event.position())) is not None:
            self.last = point
            self.update()

    def mouseReleaseEvent(self, event):
        if event.button() != Qt.LeftButton or not self.first:
            return
        end = self.point(event.position())
        first = self.first
        self.first = None
        self.update()
        if end is not None and self.input_enabled:
            self.gesture.emit({"tool": self.tool, "from": first, "to": end,
                               "duration_ms": max(50, round((time.monotonic()-self.pressed_at)*1000))})
        else:
            self.entered.emit()

    def enterEvent(self, event):
        self.entered.emit()
        super().enterEvent(event)

    def leaveEvent(self, event):
        self.left.emit()
        super().leaveEvent(event)
