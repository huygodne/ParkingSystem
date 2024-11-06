const express = require('express');
const mysql = require('mysql2');
const WebSocket = require('ws');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// Tạo ứng dụng Express
const app = express();
const port = 3000;

// Kết nối đến MySQL
const dbConfig = {
  host: 'localhost',
  user: 'root',  
  password: '12345678',  
  database: 'parking_system'
};

const connection = mysql.createConnection(dbConfig);

// Khởi tạo cổng Serial để kết nối với Arduino
const serialPort = new SerialPort({ path: 'COM3', baudRate: 9600 });
const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));

// Khởi tạo WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Lắng nghe kết nối WebSocket
wss.on('connection', (ws) => {
  console.log('Client connected to WebSocket');

  // Gửi 3 slot khi có kết nối
  connection.execute('SELECT * FROM parking_slots', (err, results) => {
    if (err) {
      ws.send('Error fetching data');
    } else {
      ws.send(JSON.stringify(results));  // Gửi 3 slot đầu tiên đến client
    }
  });

  // Lắng nghe sự thay đổi dữ liệu từ Arduino
  parser.on('data', (data) => {
    console.log(data);  // In ra slot
    
    // Kiểm tra xem dữ liệu có đúng định dạng không, ví dụ: "Slot 1: Available"
    if (data && data.includes(':')) {
      const parts = data.split(':');
      
      // Kiểm tra nếu phần đầu tiên chứa "Slot"
      if (parts[0].includes('Slot')) {
        const slot = parseInt(parts[0].split(' ')[1].trim());  // Lấy số slot
        const status = parts[1].trim().toLowerCase() === 'available' ? 0 : 1;  // Trạng thái
  
        // Tiến hành xử lý tiếp, ví dụ như cập nhật cơ sở dữ liệu, gửi WebSocket, v.v.
        console.log(`Đã phân tích Slot: ${slot}, Trạng thái: ${status}`);
        
        // Cập nhật trạng thái và lịch sử bãi đỗ
        updateSlotStatus(slot, status);
      } else {
        console.warn('Dữ l    iệu nhận được không có thông tin về Slot:', data);
      }
    } else {
      console.warn('Dữ liệu nhận được không đúng định dạng:', data);
    }
  });
  
  // Hàm cập nhật trạng thái slot
  function updateSlotStatus(slot, status) {
    // Kiểm tra trạng thái hiện tại của slot từ cơ sở dữ liệu
    connection.execute('SELECT status FROM parking_slots WHERE slot = ?', [slot], (err, results) => {
      if (err) {
        console.error('Error fetching status:', err);
      } else {
        const currentStatus = results[0]?.status;
  
        // Chỉ insert dữ liệu khi trạng thái của slot thay đổi
        if (currentStatus !== status) {
          // Cập nhật trạng thái của slot và lưu thời gian vào/ra cho xe
          if (status === 1) {
            // Xe vào bãi, lưu thời gian bắt đầu đỗ
            const query = 'INSERT INTO parking_history (slotId, timeIn) VALUES (?, ?)';
            connection.execute(query, [slot, new Date()], (err) => {
              if (err) {
                console.error('Error inserting data into parking_history:', err);
              } else {
                console.log(`Vehicle entered: Slot ${slot}, Status ${status}`);
              }
            });
          } else {
            // Xe rời khỏi bãi, cập nhật thời gian rời
            const query = 'UPDATE parking_history SET timeOut = ? WHERE slotId = ? AND timeOut IS NULL';
            connection.execute(query, [new Date(), slot], (err) => {
              if (err) {
                console.error('Error updating parking_history:', err);
              } else {
                console.log(`Vehicle left: Slot ${slot}, Status ${status}`);
              }
            });
          }
  
          // Cập nhật trạng thái của slot 
          const updateQuery = 'UPDATE parking_slots SET status = ? WHERE slot = ?';
          connection.execute(updateQuery, [status, slot], (err) => {
            if (err) {
              console.error('Error updating slot status:', err);
            } else {
              console.log(`Cập nhật slot ${slot} thành ${status}`);
              
              // Gửi lại dữ liệu đến tất cả các client kết nối
              wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  connection.execute('SELECT * FROM parking_slots', (err, results) => {
                    if (err) {
                      client.send('Error fetching data');
                    } else {
                      client.send(JSON.stringify(results));
                    }
                  });
                }
              });
            }
          });
        }
      }
    });
  }
});

// Kết nối WebSocket với server HTTP (Express)
app.server = app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

app.server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Điểm cuối để lấy lịch sử đỗ xe
app.get('/api/history', (req, res) => {
  const query = `
    SELECT id, slotId, 
           DATE_FORMAT(timeIn, '%Y/%m/%d %H:%i') AS timeIn,
           DATE_FORMAT(timeOut, '%Y/%m/%d %H:%i') AS timeOut,
           TIMESTAMPDIFF(MINUTE, timeIn, timeOut) AS totalTime
    FROM parking_history
    WHERE timeOut IS NOT NULL;
  `;
  
  connection.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching history:', err);
      res.status(500).send('Error fetching history');
    } else {
      res.json(results);  // Gửi kết quả với thời gian đã được định dạng
    }
  });
});

// Đường dẫn tới giao diện web
app.use(express.static('public'));
