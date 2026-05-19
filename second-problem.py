"""
Problem 2: The Custom Number Explorer
This problem combines his existing knowledge of while loops for error-checking with a for loop that uses range(), plus embedded logic.
1. Ask the user to enter a "maximum number".
2. Use a while loop to do error checking to ensure they actually typed a number.
3. Once you have a valid number, use a for loop to count from 1 all the way up to the user's maximum number.
4. Inside the loop, check if the current number is even. If it is even, use an embedded conditional to check if it is also a multiple of 4. If it is a multiple of 4, print "[Number] is a mega-even number!" If it's just even, print "[Number] is even."
5. If the number is not even (odd), use an embedded conditional to check if it is a multiple of 3. If it is, print "[Number] is a magic odd number!" Otherwise, just print the number normally.
"""
def main():
    while True:
        try:
            max_number = int(input("Enter a maximum number: "))
            break
        except ValueError:
            continue
    for number in range(1, max_number + 1):
        if number % 2 == 0:
            if number % 4 == 0:
                print(f"{number} is a mega-even number!")
            else:
                print(f"{number} is even.")
        else:
            if number % 3 == 0:
                print(f"{number} is a magic odd number!")
            else:
                print(number)
def withprimes():
    while True:
        try:
            max_number = int(input("Enter a maximum number: "))
            break
        except ValueError:
            continue
    for number in range(1, max_number + 1):
        if number == 1:
            print(number)
        elif number == 2:
            print(f"{number} is a prime number!")
        else:
            for i in range(2, number):
                if number % i == 0:
                    break
            else:
                print(f"{number} is a prime number!")
choice = input("Do you want the version with prime numbers (y/n)? ")
if choice == "y":
        withprimes()
elif choice == "n":
    main()
else:
    while True:
        choice = input("Do you want the version with prime numbers (y/n)? ")
        if choice == "y":
            withprimes()
        elif choice == "n":
            main()
        else:
            continue

